const fdk = require('@fnproject/fdk');
const { loadStructuredFile, loadConfigFile, saveZippedOutputFiles, saveTriggerFile } = require('./src/services/files');
const { applySplitting } = require('./src/services/splitting');

const handler = async (event = {}) => {
  let sourceFilePath = event?.data?.resourceName;
  const bucketName = event?.data?.additionalDetails?.bucketName;
  const namespaceName = event?.data?.additionalDetails?.namespace;

  if (!sourceFilePath || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  // Check that the objectName starts with "in/" and throw an error if it doesn't
  if (!sourceFilePath.startsWith('in/')) {
    throw new Error(`Object name must start with "in/", but got: ${sourceFilePath}`);
  }

  // const validateFirstLevelSubFolderName = /^\/?[^/]+\/in\//;
  // const validateSecondLevelSubFolderName = /^\/?[^/]+\/[^/]+\/in\//;
  // if (!sourceFilePath.match(validateFirstLevelSubFolderName)) {
  //   throw new Error(`Object name must start with "in/", but got: ${sourceFilePath}`);
  // }

  console.log(`v0.0.8 - Processing file: ${sourceFilePath}`);
  
  // Output directory is objectName with "in/" replaced by "out/" and filename removed, e.g. "in/config1/data.csv" -> "out/config1/"
  let outputDirectory = sourceFilePath.replace(/^in\//, 'out/').replace(/\/[^\/]+$/, '/');

  // Config path is objectName with "in/" replaced by "config/" and filename replaced, e.g. "in/config1/data.csv" -> "config/config1/config.yaml"
  let configFilePath = sourceFilePath.replace(/^in\//, 'config/').replace(/\/[^\/]+$/, '/config.yaml');

  let configFile;
  let structuredFile;

  if (namespaceName === 'localtest') {
    const path = require('path');
    configFilePath = path.resolve(process.cwd(), bucketName, configFilePath);
    sourceFilePath = path.resolve(process.cwd(), bucketName, sourceFilePath);
    outputDirectory = path.resolve(process.cwd(), bucketName, outputDirectory);
  }

  configFile = await loadConfigFile(configFilePath, bucketName, namespaceName);
  structuredFile = await loadStructuredFile(sourceFilePath, bucketName, namespaceName, configFile.structure);

  if (!configFile || !configFile.files) {
    throw new Error('Config file is missing required properties: files');
  }

  // Apply the splitting logic to the structured input file using the loaded config definition
  const { files } = await applySplitting(structuredFile, configFile);

  // Reformat JSON values into output files and write to object storage
  await saveZippedOutputFiles(outputDirectory, files, bucketName, namespaceName, sourceFilePath);
  await saveTriggerFile(outputDirectory, bucketName, namespaceName);

  console.log(`Successfully processed file: ${sourceFilePath}`);
  console.log(`Generated ${files.length} output file(s)`);

  return {
    ok: true,
    objectName: sourceFilePath,
    rowCount: structuredFile.rows.length,
  };
};

module.exports = { handler };

if (require.main === module) {
  fdk.handle(handler);
}
