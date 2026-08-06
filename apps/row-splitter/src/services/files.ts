import type { GeneratedOutputFile, StructureOptions, TabularFile } from '../types.js';
import type { RowSplitterConfig } from './configurations.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { parse as parseYaml } from 'yaml';
import { load as jsYamlLoad } from 'js-yaml';
import dayjs from 'dayjs';
import { downloadObject, uploadObject } from './oci-storage.js';
import { parseWorksheetBuffer, parseJsonDocument } from './tabular-parser.js';
import { normalizeConfigDefinition } from './configurations.js';

export { normalizeConfigDefinition };

function parseTabularContent(
    filename: string,
    content: Buffer,
    structure?: StructureOptions,
): Promise<TabularFile> | TabularFile {
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

export async function loadTabularFile(
    filename: string,
    bucketName: string,
    namespaceName: string,
    structure?: StructureOptions,
): Promise<TabularFile> {
    const { content } = await downloadObject(filename, bucketName, namespaceName);
    return parseTabularContent(filename, content, structure);
}

export async function loadConfigFile(
    configFilePath: string,
    bucketName: string,
    namespaceName: string,
): Promise<RowSplitterConfig> {
    const file = await downloadObject(configFilePath, bucketName, namespaceName);
    return normalizeConfigDefinition(parseYaml(file.content.toString('utf8')));
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

function buildTimestampedZipName(inputObjectName: string): string {
    const fileName = path.basename(inputObjectName, path.extname(inputObjectName));
    const timestamp = dayjs().format('YYYYMMDDHHmmss');
    return `${fileName}_${timestamp}.zip`;
}

function buildZipContent(outputFiles: GeneratedOutputFile[]): Promise<Buffer> {
    if (!Array.isArray(outputFiles) || outputFiles.length === 0) {
        throw new Error('At least one output file is required to save zipped output files');
    }

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

    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

export async function saveZippedOutputFiles(
    outputDirectory: string,
    outputFiles: GeneratedOutputFile[],
    bucketName: string,
    namespaceName: string,
    inputObjectName: string,
): Promise<void> {
    if (!outputDirectory) throw new Error('outputDirectory is required');
    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save output files to Object Storage');
    }
    if (!inputObjectName || typeof inputObjectName !== 'string') {
        throw new Error('inputObjectName is required to compute the output zip filename');
    }
    const normalizedDir = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;
    const zipContent = await buildZipContent(outputFiles);
    const zipFileName = buildTimestampedZipName(inputObjectName);

    await uploadObject(normalizedDir, zipFileName, zipContent, 'application/zip', bucketName, namespaceName);
}

export async function saveTriggerFile(
    outputDirectory: string,
    bucketName: string,
    namespaceName: string,
): Promise<void> {
    if (!outputDirectory) throw new Error('outputDirectory is required');
    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save the trigger file');
    }
    const normalizedDir = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;

    await uploadObject(normalizedDir, 'done.trg', Buffer.alloc(0), 'text/plain', bucketName, namespaceName);
}
