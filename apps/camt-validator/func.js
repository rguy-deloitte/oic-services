const fdk = require('@fnproject/fdk');
const path = require('node:path');
const {
  loadXmlTextFile,
  parseXmlText,
  saveXmlTextFile,
  normalizeBkToCstmrStmtTag,
  normalizeEntryDates,
} = require('./src/services/files');

const handler = async (event = {}) => {
  let sourceFilePath = event?.data?.resourceName;
  const bucketName = event?.data?.additionalDetails?.bucketName;
  const namespaceName = event?.data?.additionalDetails?.namespace;

  if (!sourceFilePath || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  if (!sourceFilePath.startsWith('camt-validator/source/')) {
    throw new Error(`Object name must start with "camt-validator/source/", but got: ${sourceFilePath}`);
  }

  const filename = path.basename(sourceFilePath);
  let outputFilePath = sourceFilePath.replace(/^camt-validator\/source\//, 'camt-validator/processed/');

  if (namespaceName === 'localtest') {
    console.log(`v0.0.1 - Processing file: ${sourceFilePath}`);
    sourceFilePath = path.resolve(process.cwd(), bucketName, sourceFilePath);
    outputFilePath = path.resolve(process.cwd(), bucketName, outputFilePath);
  }

  console.log(`Processing: ${sourceFilePath}`);

  const xmlText = await loadXmlTextFile(sourceFilePath, bucketName, namespaceName);
  const parsedXml = parseXmlText(xmlText);

  console.log('\n--- Parsed XML contents ---');
  console.log(JSON.stringify(parsedXml, null, 2));
  console.log('--- End of XML contents ---\n');

  const normalizedXmlText = normalizeEntryDates(normalizeBkToCstmrStmtTag(xmlText));

  await saveXmlTextFile(outputFilePath, normalizedXmlText, bucketName, namespaceName);

  console.log(`Saved output to: ${outputFilePath}`);

  return {
    ok: true,
    objectName: sourceFilePath,
    outputObjectName: outputFilePath,
    filename,
  };
};

module.exports = { handler };

if (require.main === module) {
  fdk.handle(handler);
}
