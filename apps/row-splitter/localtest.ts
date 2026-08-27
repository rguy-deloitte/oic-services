import { promises as fsPromises, readFileSync } from 'node:fs';
import path from 'node:path';
import { processFile } from './func.js';

const sourceObjectDir = 'row-splitter/source/test/';
const localBucketName = 'oci-object-storage';

function resolveLocalObjectPath(objectPath: string): string {
  return path.resolve(process.cwd(), localBucketName, objectPath);
}

async function downloadLocalFile(filePath: string, bucketName: string, namespaceName: string): Promise<{ content: Buffer }> {
  const content = await fsPromises.readFile(resolveLocalObjectPath(filePath));
  return { content };
}

async function uploadLocalFile(directory: string, filename: string, content: Buffer, contentType: string, bucketName: string, namespaceName: string): Promise<void> {
  const absolutePath = resolveLocalObjectPath(path.join(directory, filename));
  console.log(absolutePath);
  await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsPromises.writeFile(absolutePath, content);
}

async function runLocalTest() {
  // Get a list of all files in the source directory
  const sourceAbsolutePath = resolveLocalObjectPath(sourceObjectDir);
  const sourceFilenames = await fsPromises.readdir(sourceAbsolutePath);

  for (const sourceFilename of sourceFilenames) {
    const sourceObjectPath = `${sourceObjectDir}${sourceFilename}`;
    console.log(`Running local test for ${sourceObjectPath}`);

    await processFile(sourceObjectPath, localBucketName, 'testNamespace', downloadLocalFile, uploadLocalFile);

    const outputDirectory = sourceObjectPath.replace(/^row-splitter\/source\//, 'row-splitter/processed/').replace(/\/[^\/]+$/, '/');

    // Check that the output directory contains a zip file that begins with the input filename and ends with ".zip"
    const outputAbsolutePath = resolveLocalObjectPath(outputDirectory);
    const outputFilenames = await fsPromises.readdir(outputAbsolutePath);
    const zipFiles = outputFilenames.filter((filename) => filename.endsWith('.zip') && filename.startsWith(sourceFilename.replace(/\.[^/.]+$/, '')));
    if (zipFiles.length === 0) {
      throw new Error(`No zip file found in output directory ${outputDirectory} for input file ${sourceObjectPath}`);
    }
    console.log(`Zip file found in output directory ${outputDirectory}: ${zipFiles.join(', ')}`);

    // Confirm that a trigger file exists and then delete it for next run
    const triggerAbsolutePath = resolveLocalObjectPath(path.join(outputDirectory, 'done.trg'));
    
    try {
      readFileSync(triggerAbsolutePath);
      console.log(`Trigger file created successfully at ${triggerAbsolutePath}`);
      console.log(`Trigger file will be deleted for next run`);
      await fsPromises.unlink(triggerAbsolutePath);
    } catch (err) {
      console.error(`Trigger file was not created successfully at ${triggerAbsolutePath}`);
      throw err;
    }

    console.log(`Local test for ${sourceObjectPath} completed successfully`);
  }
}

runLocalTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};