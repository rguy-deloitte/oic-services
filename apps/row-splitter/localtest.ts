import { promises as fsPromises, readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import dayjs from 'dayjs';
import { load as jsYamlLoad } from 'js-yaml';
import { normalizeConfigDefinition } from './src/services/files.js';
import { parseJsonDocument, parseWorksheetBuffer } from './src/services/tabular-parser.js';
import { applySplitting } from './src/services/splitting.js';
import type { GeneratedOutputFile, StructureOptions, TabularFile } from './src/types.js';
import type { RowSplitterConfig } from './src/services/configurations.js';

const sourceObjectPath = 'row-splitter/source/test/concur-ap-data.csv';
const localBucketName = 'oci-object-storage';

function resolveLocalObjectPath(objectPath: string): string {
  return path.resolve(process.cwd(), localBucketName, objectPath);
}

async function loadLocalTabularFile(filename: string, structure?: StructureOptions): Promise<TabularFile> {
  const content = await fsPromises.readFile(filename);
  const extension = path.extname(filename).toLowerCase();

  switch (extension) {
    case '.csv':
    case '.xls':
    case '.xlsx':
      return parseWorksheetBuffer(filename, content, structure);
    case '.json':
      return parseJsonDocument(filename, JSON.parse(content.toString('utf8')));
    default:
      throw new Error(`Unsupported file extension: ${extension || '<none>'}`);
  }
}

function loadLocalConfigFile(configFilePath: string): RowSplitterConfig {
  return normalizeConfigDefinition(jsYamlLoad(readFileSync(configFilePath, 'utf8')));
}

function escapeCsvValue(value: unknown): string {
  const stringValue = String(value);
  if (!/[",\n\r]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function buildCsvBuffer(rows: Array<Record<string, unknown>>, includeHeader = true): Buffer {
  const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
  const csvLines: string[] = [];
  if (includeHeader && columnNames.length > 0) {
    csvLines.push(columnNames.map(escapeCsvValue).join(','));
  }
  for (const row of rows) {
    csvLines.push(columnNames.map((col) => escapeCsvValue(row[col] ?? '')).join(','));
  }
  return Buffer.from(`${csvLines.join('\n')}${csvLines.length > 0 ? '\n' : ''}`, 'utf8');
}

function buildTimestampedZipName(inputObjectPath: string): string {
  const fileName = path.basename(inputObjectPath, path.extname(inputObjectPath));
  const timestamp = dayjs().format('YYYYMMDDHHmmss');
  return `${fileName}_${timestamp}.zip`;
}

async function writeLocal(directory: string, filename: string, content: Buffer): Promise<void> {
  const filePath = path.join(directory, filename);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, content);
}

async function saveLocalZippedOutputFiles(
  outputDirectory: string,
  outputFiles: GeneratedOutputFile[],
  inputObjectPath: string,
): Promise<void> {
  if (!Array.isArray(outputFiles) || outputFiles.length === 0) {
    throw new Error('At least one output file is required to save zipped output files');
  }

  const normalizedDir = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;
  const zip = new JSZip();

  for (const file of outputFiles) {
    if (!file.name) throw new Error('Each output file must include a name');
    if (file.format === 'txt') {
      zip.file(file.name, Buffer.from(file.content || '', 'utf8'));
      continue;
    }
    if (file.format === 'csv') {
      zip.file(file.name, buildCsvBuffer(file.rows || [], file.includeHeader !== false));
      continue;
    }
    throw new Error('Unsupported output file format');
  }

  const zipContent = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await writeLocal(normalizedDir, buildTimestampedZipName(inputObjectPath), zipContent);
}

async function saveLocalTriggerFile(outputDirectory: string): Promise<void> {
  const normalizedDir = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;
  await writeLocal(normalizedDir, 'done.trg', Buffer.alloc(0));
}

async function runLocalTest() {
  const configObjectPath = sourceObjectPath
    .replace(/^row-splitter\/source\//, 'row-splitter/config/')
    .replace(/\/[^\/]+$/, '/config.yaml');
  const outputObjectPath = sourceObjectPath
    .replace(/^row-splitter\/source\//, 'row-splitter/processed/')
    .replace(/\/[^\/]+$/, '/');

  const configFilePath = resolveLocalObjectPath(configObjectPath);
  const sourceFilePath = resolveLocalObjectPath(sourceObjectPath);
  const outputDirectory = resolveLocalObjectPath(outputObjectPath);

  console.log('Loading local config and source files...');
  const configFile = loadLocalConfigFile(configFilePath);
  const sourceFile = await loadLocalTabularFile(sourceFilePath, configFile.structure);

  console.log('Applying splitting rules...');
  const { files } = await applySplitting(sourceFile, configFile);

  console.log('Writing local output files...');
  await saveLocalZippedOutputFiles(outputDirectory, files, sourceObjectPath);
  await saveLocalTriggerFile(outputDirectory);

  console.log(`Local test completed for ${sourceObjectPath}`);
  console.log(`Generated ${files.length} output file(s)`);
}

runLocalTest().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export {};