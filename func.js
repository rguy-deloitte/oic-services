const fdk = require('@fnproject/fdk');
const { loadStructuredFile, loadConfigFile, saveZippedOutputFiles, saveTriggerFile } = require('./src/services/files');
const { applySplitting } = require('./src/services/splitting');

const handler = async (event = {}) => {
  const objectName = event?.data?.resourceName;
  const bucketName = event?.data?.additionalDetails?.bucketName;
  const namespaceName = event?.data?.additionalDetails?.namespace;

  if (!objectName || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  // Check that the objectName starts with "in/" and throw an error if it doesn't
  if (!objectName.startsWith('in/')) {
    throw new Error(`Object name must start with "in/", but got: ${objectName}`);
  }

  console.log(`Processing file: ${objectName}`);
  
  // Output directory is objectName with "in/" replaced by "out/" and filename removed, e.g. "in/config1/data.csv" -> "out/config1/"
  const outputDirectory = objectName.replace(/^in\//, 'out/').replace(/\/[^\/]+$/, '/');

  // Config path is objectName with "in/" replaced by "config/" and filename replaced, e.g. "in/config1/data.csv" -> "config/config1/config.yaml"
  const configFilePath = objectName.replace(/^in\//, 'config/').replace(/\/[^\/]+$/, '/config.yaml');

  // Load the config file and structured input file from object storage based on the event data
  const configFile = await loadConfigFile(configFilePath, bucketName, namespaceName);
  const structuredFile = await loadStructuredFile(objectName, bucketName, namespaceName, configFile.structure);

  if (!configFile || !configFile.files) {
    throw new Error('Config file is missing required properties: files');
  }

  // Apply the splitting logic to the structured input file using the loaded config definition
  const { files } = await applySplitting(structuredFile, configFile);

  // Reformat JSON values into output files and write to object storage
  await saveZippedOutputFiles(outputDirectory, files, bucketName, namespaceName, objectName);
  await saveTriggerFile(outputDirectory, bucketName, namespaceName);

  console.log(`Successfully processed file: ${objectName}`);
  console.log(`Generated ${files.length} output file(s)`);

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
