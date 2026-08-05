import type { RowSplitterConfig, TabularFile } from './src/types';
import { loadStructuredFile, loadConfigFile, saveZippedOutputFiles, saveTriggerFile } from './src/services/files';
import { applySplitting } from './src/services/splitting';

const fdk = require('@fnproject/fdk');

type ObjectStorageEvent = {
  data?: {
    resourceName?: string;
    additionalDetails?: {
      bucketName?: string;
      namespace?: string;
    };
  };
};

const handler = async (event: ObjectStorageEvent = {}) => {
  let sourceFilePath: string | undefined = event?.data?.resourceName;
  const bucketName: string | undefined = event?.data?.additionalDetails?.bucketName;
  const namespaceName: string | undefined = event?.data?.additionalDetails?.namespace;

  if (!sourceFilePath || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  // Check that the objectName starts with "in/" and throw an error if it doesn't
  if (!sourceFilePath.startsWith('row-splitter/source/')) {
    throw new Error(`Object name must start with "row-splitter/source/", but got: ${sourceFilePath}`);
  }

  console.log(`v0.0.9 - Processing file: ${sourceFilePath}`);
  
  // Output directory is objectName with "row-splitter/source/" replaced by "row-splitter/processed/" and filename removed, e.g. "row-splitter/source/config1/data.csv" -> "row-splitter/processed/config1/"
  let outputDirectory: string = sourceFilePath.replace(/^row-splitter\/source\//, 'row-splitter/processed/').replace(/\/[^\/]+$/, '/');

  // Config path is objectName with "row-splitter/source/" replaced by "row-splitter/config/" and filename replaced, e.g. "row-splitter/source/config1/data.csv" -> "row-splitter/config/config1/config.yaml"
  let configFilePath: string = sourceFilePath.replace(/^row-splitter\/source\//, 'row-splitter/config/').replace(/\/[^\/]+$/, '/config.yaml');

  let configFile: RowSplitterConfig;
  let structuredFile: TabularFile;

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

export {};
