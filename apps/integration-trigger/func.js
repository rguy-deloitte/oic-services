const fdk = require('@fnproject/fdk');
const { callOICIntegrationTrigger } = require('./src/calls');

const handler = async (event = {}) => {
  const triggerFilePath = event?.data?.resourceName;
  const bucketName = event?.data?.additionalDetails?.bucketName;
  const namespaceName = event?.data?.additionalDetails?.namespace;

  if (!triggerFilePath || !bucketName || !namespaceName) {
    throw new Error('Object Storage event must include data.resourceName, data.additionalDetails.bucketName, and data.additionalDetails.namespace');
  }

  console.log(`v0.0.1 - Processing file: ${triggerFilePath}`);

  const triggerFileParts = triggerFilePath.split('/');
  if (triggerFileParts.length !== 3) {
    throw new Error(`Trigger file path must have 3 parts separated by "/", but got: ${triggerFilePath}`);
  }
  
  // Construct file paths based on the triggering file path
  const location = triggerFileParts[0];
  const instance = triggerFileParts[1];
  const filename = triggerFileParts[2];

  const archivePath = `/archive/${instance}/${filename}`;
  const erroredPath = `/errored/${instance}/${filename}`;

  // configFile = await loadConfigFile(configFilePath, bucketName, namespaceName);

  // if (!configFile || !configFile.files) {
  //   throw new Error('Config file is missing required properties: files');
  // }

  // Create a json object, containing "triggerFilePath", "archivePath", "erroredPath", and "jobName"
  const payload = {
    "filepath" :triggerFilePath,
    "archivePath": archivePath,
    "erroredPath": erroredPath,
    "jobName": "test"
  };

  const oicResponse = await callOICIntegrationTrigger(payload);
  console.log(`Triggered OIC integration successfully: HTTP ${oicResponse.status}`);

  return {
    ok: true,
    oicStatus: oicResponse.status
  };
};

module.exports = { handler };

if (require.main === module) {
  fdk.handle(handler);
}
