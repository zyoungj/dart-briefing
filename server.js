require('dotenv').config();

const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DART_API_KEY = process.env.DART_API_KEY;
const ACTION_API_KEY = process.env.ACTION_API_KEY;

// corpCodes.json 불러오기
const corpCodesPath = path.join(__dirname, 'corpCodes.json');
const corpCodes = JSON.parse(fs.readFileSync(corpCodesPath, 'utf8'));

// 인증 체크
function checkActionApiKey(req, res, next) {
  const auth = req.headers.authorization;

  // 브라우저에서 직접 테스트할 때는 인증 없이 허용
  if (!ACTION_API_KEY) {
    return next();
  }

  if (!auth) {
    return next();
  }

  if (auth === `Bearer ${ACTION_API_KEY}`) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

// 숫자 문자열을 숫자로 변환
function parseAmount(value) {
  if (!value) return null;
  const num = Number(String(value).replace(/,/g, ''));
  return Number.isNaN(num) ? null : num;
}

// 증감률 계산
function calcChangeRate(current, previous) {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// 회사명으로 corp_code 찾기
function findCorpCodeByName(companyName) {
  let found = corpCodes.find(item => item.corp_name === companyName);

  if (!found) {
    found = corpCodes.find(
      item => item.corp_name && item.corp_name.includes(companyName)
    );
  }

  return found || null;
}

// 회사명으로 회사 정보 찾기
async function getCorpInfoByName(companyName) {
  const foundCompany = findCorpCodeByName(companyName);

  if (!foundCompany) {
    throw new Error('해당 회사명을 corpCodes.json에서 찾지 못했습니다.');
  }

  return foundCompany;
}

// 기업 기본정보 조회
async function getCompanyInfo(corpCode) {
  const url = 'https://opendart.fss.or.kr/api/company.json';

  const response = await axios.get(url, {
    params: {
      crtfc_key: DART_API_KEY,
      corp_code: corpCode
    }
  });

  return response.data;
}

// 최근 공시 가져오기
async function getRecentDisclosures(corpCode) {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');

  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const beginDate = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');

  const url = 'https://opendart.fss.or.kr/api/list.json';

  const response = await axios.get(url, {
    params: {
      crtfc_key: DART_API_KEY,
      corp_code: corpCode,
      bgn_de: beginDate,
      end_de: endDate,
      page_count: 10
    }
  });

  return response.data.list || [];
}

// 재무 주요계정 가져오기
async function getFinanceSummary(corpCode, year = '2025', report = '11011') {
  const url = 'https://opendart.fss.or.kr/api/fnlttSinglAcnt.json';

  const response = await axios.get(url, {
    params: {
      crtfc_key: DART_API_KEY,
      corp_code: corpCode,
      bsns_year: year,
      reprt_code: report
    }
  });

  const list = response.data.list || [];
  const wantedAccounts = ['매출액', '영업이익', '당기순이익'];

  return list.filter(item => wantedAccounts.includes(item.account_nm));
}

// 재무 신호 만들기
function buildFinanceSignals(financeList) {
  const result = [];

  financeList.forEach(item => {
    const accountName = item.account_nm;
    const current = parseAmount(item.thstrm_add_amount || item.thstrm_amount);
    const previous = parseAmount(item.frmtrm_add_amount || item.frmtrm_amount);
    const changeRate = calcChangeRate(current, previous);

    let trend = '변화 확인 어려움';
    if (changeRate !== null) {
      if (changeRate > 5) trend = '증가';
      else if (changeRate < -5) trend = '감소';
      else trend = '유사';
    }

    let specialNote = '';
    if (accountName === '영업이익' || accountName === '당기순이익') {
      if (current !== null && previous !== null) {
        if (previous < 0 && current > 0) specialNote = '흑자전환';
        else if (previous > 0 && current < 0) specialNote = '적자전환';
      }
    }

    result.push({
      accountName,
      current,
      previous,
      changeRate: changeRate !== null ? changeRate.toFixed(1) + '%' : null,
      trend,
      specialNote
    });
  });

  return result;
}

// 중요 공시만 선별
function pickImportantDisclosures(disclosures) {
  const keywords = [
    '대표이사',
    '임원',
    '주주총회',
    '합병',
    '분할',
    '영업양수도',
    '신규시설투자',
    '투자판단',
    '단일판매',
    '공급계약',
    '유상증자',
    '해외',
    '공장',
    '신사업'
  ];

  return disclosures.filter(item => {
    const name = item.report_nm || '';
    return keywords.some(keyword => name.includes(keyword));
  });
}

// 영업 힌트 만들기
function buildSalesHints(financeSignals, importantDisclosures) {
  const hints = [];

  const sales = financeSignals.find(item => item.accountName === '매출액');
  const op = financeSignals.find(item => item.accountName === '영업이익');

  if (sales && sales.trend === '증가') {
    hints.push('매출 성장 흐름이 확인되어 생산·운영·공급망 관련 시스템 고도화 수요를 검토할 수 있습니다.');
  }

  if (op && op.specialNote === '적자전환') {
    hints.push('수익성 악화 신호가 있어 비용절감, 운영효율화, ITO 제안 논리가 유효할 수 있습니다.');
  }

  if (op && op.specialNote === '흑자전환') {
    hints.push('수익성 개선 신호가 있어 중장기 IT투자 재개 가능성을 함께 볼 수 있습니다.');
  }

  const reportNames = importantDisclosures.map(item => item.report_nm || '');

  if (reportNames.some(name => name.includes('신규시설투자') || name.includes('공장'))) {
    hints.push('시설투자 또는 공장 관련 공시가 있어 MES, 설비연계, 생산관리 영역 기회를 검토할 수 있습니다.');
  }

  if (reportNames.some(name => name.includes('합병') || name.includes('분할') || name.includes('영업양수도'))) {
    hints.push('조직·법인 구조 변화 가능성이 있어 ERP/데이터/프로세스 통합 수요를 검토할 수 있습니다.');
  }

  if (reportNames.some(name => name.includes('해외'))) {
    hints.push('해외 관련 공시가 있어 글로벌 ERP, SCM, 연결관리 이슈가 있는지 확인해볼 만합니다.');
  }

  if (reportNames.some(name => name.includes('대표이사') || name.includes('임원') || name.includes('주주총회'))) {
    hints.push('경영진 및 의사결정 변화 신호가 있어 전략 방향 변화 여부를 추가 확인할 필요가 있습니다.');
  }

  if (reportNames.some(name => name.includes('단일판매') || name.includes('공급계약'))) {
    hints.push('대형 계약 신호가 있어 생산계획, 공급망, 원가관리 시스템 고도화 필요성을 점검할 수 있습니다.');
  }

  if (hints.length === 0) {
    hints.push('현재 공시만으로 뚜렷한 변화 신호는 제한적이며, 최근 분기 실적과 사업보고서 본문 비교를 추가하는 것이 좋습니다.');
  }

  return hints;
}

// 문장형 요약
function buildFinanceSentence(financeSignals) {
  let sentences = [];

  financeSignals.forEach(item => {
    let line = `${item.accountName}은(는) `;

    if (item.specialNote) {
      line += `${item.specialNote}`;
    } else {
      line += `${item.trend}`;
    }

    if (item.changeRate) {
      line += ` (${item.changeRate})`;
    }

    line += ' 추세를 보인다.';
    sentences.push(line);
  });

  return sentences.join(' ');
}

function buildDisclosureSentence(disclosures) {
  if (!disclosures || disclosures.length === 0) {
    return '최근 공시에서 뚜렷한 주요 이벤트는 제한적이다.';
  }

  const lines = disclosures.slice(0, 5).map(item => {
    return `- ${item.rcept_dt} : ${item.report_nm}`;
  });

  return lines.join('\n');
}

function buildSummaryText(data) {
  const { company, financeSignals, importantDisclosures, salesHints } = data;

  return `
[기업 브리핑]

■ 회사 개요
${company.matchedCompanyName}는 대표이사 ${company.ceo || '정보없음'} 체제의 기업으로, 본사는 ${company.address || '정보없음'}에 위치한다.

■ 최근 실적 변화
${buildFinanceSentence(financeSignals)}

■ 주요 공시
${buildDisclosureSentence(importantDisclosures)}

■ IT영업 시사점
${salesHints.map(h => `- ${h}`).join('\n')}
`;
}

// 기본 페이지
app.get('/', (req, res) => {
  res.send('DART 브리핑 서버가 실행 중입니다.');
});

// company
app.get('/company', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /company?name=삼성전자'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);

    res.json({
      searchName: companyName,
      matchedCompanyName: foundCompany.corp_name,
      corpCode: foundCompany.corp_code,
      stockCode: foundCompany.stock_code,
      modifyDate: foundCompany.modify_date,
      companyInfo: {
        corp_name: companyInfo.corp_name,
        corp_name_eng: companyInfo.corp_name_eng,
        stock_name: companyInfo.stock_name,
        stock_code: companyInfo.stock_code,
        ceo_nm: companyInfo.ceo_nm,
        corp_cls: companyInfo.corp_cls,
        jurir_no: companyInfo.jurir_no,
        bizr_no: companyInfo.bizr_no,
        adres: companyInfo.adres,
        hm_url: companyInfo.hm_url,
        ir_url: companyInfo.ir_url,
        phn_no: companyInfo.phn_no,
        fax_no: companyInfo.fax_no,
        induty_code: companyInfo.induty_code,
        est_dt: companyInfo.est_dt,
        acc_mt: companyInfo.acc_mt
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '회사 정보 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// disclosures
app.get('/disclosures', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /disclosures?name=삼성전자'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);

    res.json({
      searchName: companyName,
      matchedCompanyName: foundCompany.corp_name,
      corpCode: foundCompany.corp_code,
      disclosures
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '최근 공시 목록 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// finance
app.get('/finance', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /finance?name=삼성전자&year=2025&report=11011'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    res.json({
      searchName: companyName,
      matchedCompanyName: foundCompany.corp_name,
      corpCode: foundCompany.corp_code,
      year,
      report,
      summary: finance
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '재무 주요계정 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// briefing
app.get('/briefing', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /briefing?name=삼성전자'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    res.json({
      company: {
        searchName: companyName,
        matchedCompanyName: foundCompany.corp_name,
        corpCode: foundCompany.corp_code,
        stockCode: foundCompany.stock_code,
        ceo: companyInfo.ceo_nm,
        address: companyInfo.adres,
        homepage: companyInfo.hm_url,
        irPage: companyInfo.ir_url,
        establishedDate: companyInfo.est_dt,
        fiscalMonth: companyInfo.acc_mt
      },
      finance: finance.map(item => ({
        accountName: item.account_nm,
        currentAmount: item.thstrm_amount,
        previousAmount: item.frmtrm_amount,
        currency: item.currency
      })),
      recentDisclosures: disclosures.map(item => ({
        date: item.rcept_dt,
        reportName: item.report_nm,
        receiptNo: item.rcept_no
      })),
      comment: '기업개요 + 최근공시 + 재무요약 통합 결과입니다.'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '브리핑 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// signals
app.get('/signals', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /signals?name=삼성전자'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    const financeSignals = buildFinanceSignals(finance);
    const importantDisclosures = pickImportantDisclosures(disclosures);
    const salesHints = buildSalesHints(financeSignals, importantDisclosures);

    res.json({
      company: {
        searchName: companyName,
        matchedCompanyName: foundCompany.corp_name,
        corpCode: foundCompany.corp_code,
        stockCode: foundCompany.stock_code,
        ceo: companyInfo.ceo_nm,
        address: companyInfo.adres
      },
      financeSignals,
      importantDisclosures: importantDisclosures.map(item => ({
        date: item.rcept_dt,
        reportName: item.report_nm,
        receiptNo: item.rcept_no
      })),
      salesHints
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '변화 신호 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// summary
app.get('/summary', checkActionApiKey, async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).send('회사명을 입력해주세요.');
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    const financeSignals = buildFinanceSignals(finance);
    const importantDisclosures = pickImportantDisclosures(disclosures);
    const salesHints = buildSalesHints(financeSignals, importantDisclosures);

    const summaryText = buildSummaryText({
      company: {
        matchedCompanyName: foundCompany.corp_name,
        ceo: companyInfo.ceo_nm,
        address: companyInfo.adres
      },
      financeSignals,
      importantDisclosures,
      salesHints
    });

    res.send(summaryText);
  } catch (error) {
    console.error(error);
    res.status(500).send(`브리핑 생성 중 오류 발생: ${error.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 주소: http://localhost:${PORT}`);
});