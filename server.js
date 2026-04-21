require('dotenv').config();

const express = require('express');
const axios = require('axios');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 3000;
const DART_API_KEY = process.env.DART_API_KEY;

// 홈 화면
app.get('/', (req, res) => {
  res.send('DART 브리핑 서버가 실행 중입니다.');
});

// 1) corpCode.xml ZIP 다운로드
async function downloadCorpCodeZip() {
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer'
  });

  return response.data;
}

// 2) ZIP 안의 XML 꺼내기
function extractXmlFromZip(zipBuffer) {
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();

  if (zipEntries.length === 0) {
    throw new Error('ZIP 안에 파일이 없습니다.');
  }

  // 보통 첫 번째 파일이 CORPCODE.xml 입니다.
  const xmlText = zipEntries[0].getData().toString('utf8');
  return xmlText;
}

// 3) XML을 JSON처럼 바꾸기
async function parseCorpCodeXml(xmlText) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    trim: true
  });

  const result = await parser.parseStringPromise(xmlText);
  return result;
}

// 4) 회사명으로 corp_code 찾기
function findCorpCodeByName(parsedXml, companyName) {
  const list = parsedXml.result.list;

  // list가 1개면 배열이 아닐 수도 있으니 배열 처리
  const companyList = Array.isArray(list) ? list : [list];

  // 정확히 일치하는 회사를 먼저 찾기
  let found = companyList.find(
    (item) => item.corp_name === companyName
  );

  // 없으면 부분 일치로 한 번 더 찾기
  if (!found) {
    found = companyList.find(
      (item) => item.corp_name && item.corp_name.includes(companyName)
    );
  }

  return found || null;
}



// 회사명으로 corp_code 찾아주는 공통 함수
async function getCorpInfoByName(companyName) {
  const zipBuffer = await downloadCorpCodeZip();
  const xmlText = extractXmlFromZip(zipBuffer);
  const parsedXml = await parseCorpCodeXml(xmlText);
  const foundCompany = findCorpCodeByName(parsedXml, companyName);

  if (!foundCompany) {
    throw new Error('해당 회사명을 DART corpCode 목록에서 찾지 못했습니다.');
  }

  return foundCompany;
}



// 5) corp_code로 회사 기본정보 조회
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

// 회사명으로 기업개황 조회
app.get('/company', async (req, res) => {
  const companyName = req.query.name;

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /company?name=삼성전자'
    });
  }

  try {
    // A. corpCode.xml ZIP 다운로드
    const zipBuffer = await downloadCorpCodeZip();

    // B. ZIP에서 XML 추출
    const xmlText = extractXmlFromZip(zipBuffer);

    // C. XML 파싱
    const parsedXml = await parseCorpCodeXml(xmlText);

    // D. 회사명으로 corp_code 찾기
    const foundCompany = findCorpCodeByName(parsedXml, companyName);

    if (!foundCompany) {
      return res.status(404).json({
        error: '해당 회사명을 DART corpCode 목록에서 찾지 못했습니다.',
        companyName: companyName
      });
    }

    // E. 기업개황 조회
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);

    // F. 보기 쉽게 정리해서 반환
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
      error: '처리 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});


// 최근 공시 목록 조회
app.get('/disclosures', async (req, res) => {
  const companyName = req.query.name;

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /disclosures?name=삼성전자'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);

    // 오늘 날짜 기준으로 최근 1년
    const today = new Date();
    const endDate = today.toISOString().slice(0, 10).replace(/-/g, '');
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(today.getFullYear() - 1);
    const beginDate = oneYearAgo.toISOString().slice(0, 10).replace(/-/g, '');

    const url = 'https://opendart.fss.or.kr/api/list.json';

    const response = await axios.get(url, {
      params: {
        crtfc_key: DART_API_KEY,
        corp_code: foundCompany.corp_code,
        bgn_de: beginDate,
        end_de: endDate,
        page_count: 10
      }
    });

    res.json({
      searchName: companyName,
      matchedCompanyName: foundCompany.corp_name,
      corpCode: foundCompany.corp_code,
      disclosures: response.data.list || [],
      status: response.data.status,
      message: response.data.message
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: '최근 공시 목록 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});



// 재무 주요계정 조회
app.get('/finance', async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011'; 
  // 11011: 사업보고서, 11012: 반기보고서, 11013: 1분기보고서, 11014: 3분기보고서

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /finance?name=삼성전자&year=2025&report=11011'
    });
  }

  try {
    const foundCompany = await getCorpInfoByName(companyName);

    const url = 'https://opendart.fss.or.kr/api/fnlttSinglAcnt.json';

    const response = await axios.get(url, {
      params: {
        crtfc_key: DART_API_KEY,
        corp_code: foundCompany.corp_code,
        bsns_year: year,
        reprt_code: report
      }
    });

    const list = response.data.list || [];

    // 영업에 자주 보는 핵심 계정만 먼저 추리기
    const keywords = ['매출액', '영업이익', '당기순이익'];
    const summary = list.filter(item =>
      keywords.includes(item.account_nm)
    );

    res.json({
      searchName: companyName,
      matchedCompanyName: foundCompany.corp_name,
      corpCode: foundCompany.corp_code,
      year: year,
      report: report,
      summary: summary,
      rawCount: list.length,
      status: response.data.status,
      message: response.data.message
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: '재무 주요계정 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

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
      page_count: 5
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



// 기업 브리핑 통합 조회
app.get('/briefing', async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /briefing?name=삼성전자'
    });
  }

  try {
    // 1. 회사명으로 corp_code 찾기
    const foundCompany = await getCorpInfoByName(companyName);

    // 2. 회사 기본정보
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);

    // 3. 최근 공시
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);

    // 4. 재무 요약
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    // 5. 보기 쉽게 정리
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
      comment: '여기까지 되면 기업개요 + 최근공시 + 재무요약을 한 번에 조회하는 기본 브리핑이 완성된 상태입니다.'
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: '브리핑 조회 중 오류가 발생했습니다.',
      detail: error.message
    });
  }
});

// 숫자 문자열을 숫자로 바꾸는 함수
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

// 재무 요약을 보기 쉽게 정리
function buildFinanceSignals(financeList) {
  const result = [];

  financeList.forEach(item => {
    const accountName = item.account_nm;

    // 손익계산서 계정은 누적금액을 우선 사용
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
        if (previous < 0 && current > 0) {
          specialNote = '흑자전환';
        } else if (previous > 0 && current < 0) {
          specialNote = '적자전환';
        }
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

// 최근 공시 중 중요 키워드만 선별
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

// IT영업 관점의 간단 코멘트 생성
function buildSalesHints(financeSignals, importantDisclosures) {
  const hints = [];

  // 재무 신호
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

  // 공시 신호
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



// 변화 신호 요약
app.get('/signals', async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).json({
      error: '회사명을 입력해주세요. 예: /signals?name=삼성전자'
    });
  }

  try {
    // 1. 회사 찾기
    const foundCompany = await getCorpInfoByName(companyName);

    // 2. 회사 기본정보
    const companyInfo = await getCompanyInfo(foundCompany.corp_code);

    // 3. 최근 공시 1년치
    const disclosures = await getRecentDisclosures(foundCompany.corp_code);

    // 4. 재무 요약
    const finance = await getFinanceSummary(foundCompany.corp_code, year, report);

    // 5. 변화 신호 만들기
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


function formatNumber(num) {
  if (num === null) return '확인 필요';
  return Number(num).toLocaleString();
}


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



// 문장형 브리핑
app.get('/summary', async (req, res) => {
  const companyName = req.query.name;
  const year = req.query.year || '2025';
  const report = req.query.report || '11011';

  if (!companyName) {
    return res.status(400).send('회사명을 입력해주세요.');
  }

  try {
    // 기존 로직 그대로 재사용
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
    res.status(500).send('브리핑 생성 중 오류 발생');
  }
});



app.listen(PORT, () => {
  console.log(`서버 실행 주소: http://localhost:${PORT}`);
});