require('dotenv').config();

const fs = require('fs');
const axios = require('axios');
const AdmZip = require('adm-zip');
const xml2js = require('xml2js');

const DART_API_KEY = process.env.DART_API_KEY;

async function main() {
  const url = `https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${DART_API_KEY}`;

  const response = await axios.get(url, {
    responseType: 'arraybuffer'
  });

  const zip = new AdmZip(response.data);
  const entries = zip.getEntries();

  if (entries.length === 0) {
    throw new Error('ZIP 안에 파일이 없습니다.');
  }

  const xmlText = entries[0].getData().toString('utf8');

  const parser = new xml2js.Parser({
    explicitArray: false,
    trim: true
  });

  const parsed = await parser.parseStringPromise(xmlText);
  const list = parsed.result.list;
  const companyList = Array.isArray(list) ? list : [list];

  fs.writeFileSync(
    'corpCodes.json',
    JSON.stringify(companyList, null, 2),
    'utf8'
  );

  console.log(`corpCodes.json 생성 완료: ${companyList.length}건`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});