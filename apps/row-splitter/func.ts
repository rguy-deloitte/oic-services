import type { RowSplitterConfig } from './src/services/configurations.js';
import type { TabularFile } from './src/services/tabular-parser.js';
import { loadTabularFile, loadConfigFile, saveZippedOutputFiles, saveTriggerFile } from './src/services/files.js';
import { applySplitting } from './src/services/splitting.js';

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

  // Check that the objectName starts with "row-splitter/source/" and throw an error if it doesn't
  if (!sourceFilePath.startsWith('row-splitter/source/')) {
    throw new Error(`Object name must start with "row-splitter/source/", but got: ${sourceFilePath}`);
  }

  await processFile(sourceFilePath, bucketName, namespaceName);

  return {
    ok: true,
    message: `Successfully processed file: ${sourceFilePath}`,
  };
};

async function processFile(sourceFilePath: string, bucketName: string, namespaceName: string, 
                           downloadFunction?: Function | undefined, uploadFunction?: Function | undefined): Promise<void> {
  // Check that the sourceFilePath starts with "row-splitter/source/" and throw an error if it doesn't
  if (!sourceFilePath.startsWith('row-splitter/source/')) {
    throw new Error(`Object name must start with "row-splitter/source/", but got: ${sourceFilePath}`);
  }

  console.log(`Processing file: ${sourceFilePath}`);
  
  // Output directory is objectName with "row-splitter/source/" replaced by "row-splitter/processed/" and filename removed, e.g. "row-splitter/source/config1/data.csv" -> "row-splitter/processed/config1/"
  let outputDirectory: string = sourceFilePath.replace(/^row-splitter\/source\//, 'row-splitter/processed/').replace(/\/[^\/]+$/, '/');

  // Config path is objectName with "row-splitter/source/" replaced by "row-splitter/config/" and filename replaced, e.g. "row-splitter/source/config1/data.csv" -> "row-splitter/config/config1/config.yaml"
  let configFilePath: string = sourceFilePath.replace(/^row-splitter\/source\//, 'row-splitter/config/').replace(/\/[^\/]+$/, '/config.yaml');

  let configFile: RowSplitterConfig = await loadConfigFile(configFilePath, bucketName, namespaceName, downloadFunction);
  let sourceFile: TabularFile = await loadTabularFile(sourceFilePath, bucketName, namespaceName, configFile.sourceFile, downloadFunction);

  if (!configFile || !configFile.files) {
    throw new Error('Config file is missing required properties: files');
  }

  // Apply the splitting logic to the structured input file using the loaded config definition
  const { files } = await applySplitting(sourceFile, configFile);

  // Reformat JSON values into output files and write to object storage
  await saveZippedOutputFiles(outputDirectory, files, bucketName, namespaceName, sourceFilePath, configFile.outputFile, uploadFunction);
  await saveTriggerFile(outputDirectory, bucketName, namespaceName, uploadFunction);

  console.log(`Successfully processed file: ${sourceFilePath}`);
  console.log(`Generated ${files.length} output file(s)`);
}

export { processFile };

if (require.main === module) {
  fdk.handle(handler);
}

export {};
