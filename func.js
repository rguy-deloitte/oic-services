const fdk = require('@fnproject/fdk');
const { loadStructuredFile, loadFormatFile, saveZippedOutputFiles, saveTriggerFile } = require('./src/services/files');
const { applySplitting } = require('./src/services/splitting');

const handler = async (event = {}) => {
  const objectName = event?.data?.resourceName;
  const bucketName = event?.data?.additionalDetails?.bucketName;
  const namespaceName = event?.data?.additionalDetails?.namespace;

  if (!objectName || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  // Output directory is objectName with "/in/" replaced by "/out/" and filename removed, e.g. "input/format1/data.csv" -> "output/format1/"
  const outputDirectory = objectName.replace(/\/in\//, '/out/').replace(/\/[^\/]+$/, '/');

  console.log(`Processing file: ${objectName}`);

  // Load the format file and structured input file from object storage based on the event data
  const formatFile = await loadFormatFile(objectName, bucketName, namespaceName);
  const structuredFile = await loadStructuredFile(objectName, bucketName, namespaceName, formatFile.structure);

  // Check that format file contains the correct entries (metadata, groupBy, header, line)
  if (!formatFile || !formatFile.metadata || !formatFile.groupBy || !formatFile.header || !formatFile.line) {
    throw new Error('Format file is missing required properties (metadata, groupBy, header, line)');
  }

  // Apply the splitting logic to the structured input file using the loaded format definition
  const { headers, lines } = await applySplitting(structuredFile, formatFile);

  // Reformat JSON values into header and line csv files and write to object storage
  await saveZippedOutputFiles(outputDirectory, headers, lines, formatFile.metadata, bucketName, namespaceName);
  await saveTriggerFile(outputDirectory, bucketName, namespaceName);

  console.log(`Successfully processed file: ${objectName}`);
  console.log(`Generated ${headers.length} header records and ${lines.length} line records`);

  return {
    ok: true,
    objectName,
    rowCount: structuredFile.rows.length,
  };
};

module.exports = { handler };

if (require.main === module) {
  fdk.handle(handler);
}
