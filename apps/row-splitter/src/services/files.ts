import type {
    GeneratedOutputFile,
    OutputFileDefinition,
    RowSplitterConfig,
    StructureOptions,
    TabularFile,
    TabularRow,
} from '../types';
import { promises as fsPromises, readFileSync } from 'node:fs';
import path from 'node:path';
import { ResourcePrincipalAuthenticationDetailsProvider } from 'oci-common';
import { ObjectStorageClient } from 'oci-objectstorage';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { parse as parseYaml } from 'yaml';
import { load as jsYamlLoad } from 'js-yaml';
import dayjs from 'dayjs';

interface ObjectStorageFile {
    filename: string;
    bucketName: string;
    namespaceName: string;
    contentType: string;
    content: Buffer;
}

interface NormalizedWorksheetStructure {
    headerRowPresent: boolean;
    ignoreHeaderRow: boolean;
}

interface RepeatSectionDefinition {
    prefix?: string;
    start?: number | string;
    size?: number | string;
    end?: number | string;
    fields?: Record<string, unknown>;
}

interface ArrayBufferBody { arrayBuffer(): Promise<ArrayBuffer> }
interface StreamReaderBody { getReader(): { read(): Promise<{ done: boolean; value: Uint8Array | undefined }> } }

// Reuse a single OCI Object Storage client across invocations within the same
// function container. Caching the client avoids rebuilding the resource principal
// provider for every file read/write
let objectStorageClientPromise: Promise<ObjectStorageClient> | undefined;

// Build and cache the OCI Object Storage client used by loadFileFromObjectStorage.
function getObjectStorageClient(): Promise<ObjectStorageClient> {
    if (!objectStorageClientPromise) {
        objectStorageClientPromise = (async () => {
            const authenticationDetailsProvider = await ResourcePrincipalAuthenticationDetailsProvider.builder();

            return new ObjectStorageClient({
                authenticationDetailsProvider,
            });
        })();
    }

    return objectStorageClientPromise;
}

// Loads a structured file (CSV, XLSX, or JSON) from blob storage and returns it as a JSON object
//
// This is the high-level entry point used by the main handler:
// 1. Work out the file type from the extension.
// 2. Download the raw file bytes from Object Storage.
// 3. Route the content to the correct parser.
// 4. Return a normalized JSON object with filename and rows.
async function loadTabularFile(
    filename: string,
    bucketName: string,
    namespaceName: string,
    structure?: StructureOptions,
): Promise<TabularFile> {
    const extension = path.extname(filename).toLowerCase();
    let content: Buffer;

    if (namespaceName == 'localtest') {
        // load file from local filesystem
        content = await fsPromises.readFile(filename);
    } else {
        ({ content } = await loadFileFromObjectStorage(filename, bucketName, namespaceName));
    }

    // Route based on file extension so splitting logic can handle any format
    switch (extension) {
        case '.csv':
        case '.xls':
        case '.xlsx':
            return parseWorksheetBuffer(filename, content, structure);
        case '.json':
            // Decode text content before parsing JSON.
            return normalizeJsonDocument(filename, JSON.parse(content.toString('utf8')));
        default:
            throw new Error(`Unsupported structured file extension: ${extension || '<none>'}`);
    }
}

// Loads a config file from object storage based on the path of the input file
async function loadConfigFile(configFilePath: string, bucketName: string, namespaceName: string): Promise<RowSplitterConfig> {
    if (namespaceName == 'localtest') {
        return normalizeConfigDefinition(jsYamlLoad(readFileSync(configFilePath, 'utf8')));
    } else {
        const configContent = await loadFileFromObjectStorage(configFilePath, bucketName, namespaceName);
        return normalizeConfigDefinition(parseYaml(configContent.content.toString('utf8')));
    }
}

function normalizeConfigDefinition(configDefinition: unknown): RowSplitterConfig {
    if (!configDefinition || typeof configDefinition !== 'object' || Array.isArray(configDefinition)) {
        return configDefinition as RowSplitterConfig;
    }

    const config = configDefinition as RowSplitterConfig;

    const normalizedFiles = normalizeFilesDefinition(config.files);

    if (!normalizedFiles && (config.header || config.line || config.metadata)) {
        return {
            ...config,
            files: normalizeLegacyFileDefinitions(config),
        };
    }

    return {
        ...config,
        files: normalizedFiles,
    };
}

function normalizeFilesDefinition(filesDefinition: unknown): Record<string, OutputFileDefinition> | undefined {
    if (!filesDefinition) {
        return undefined;
    }

    if (typeof filesDefinition !== 'object' || Array.isArray(filesDefinition)) {
        throw new Error('files must be an object');
    }

    return Object.fromEntries(
        Object.entries(filesDefinition).map(([fileName, fileDefinition]) => [
            fileName,
            normalizeFileDefinition(fileName, fileDefinition),
        ]),
    );
}

function normalizeLegacyFileDefinitions(configDefinition: RowSplitterConfig): Record<string, OutputFileDefinition> {
    const files: Record<string, OutputFileDefinition> = {};

    if (configDefinition.header) {
        files['XlaTrxH.csv'] = normalizeFileDefinition('XlaTrxH.csv', configDefinition.header, 'csv');
    }

    if (configDefinition.line) {
        files['XlaTrxL.csv'] = normalizeFileDefinition('XlaTrxL.csv', configDefinition.line, 'csv');
    }

    if (configDefinition.metadata && configDefinition.metadata.name && configDefinition.metadata.version) {
        files[`Metadata_${configDefinition.metadata.name}.txt`] = {
            format: 'txt',
            content: `Metadata version number : ${configDefinition.metadata.version}\nApplication Short Name : ${configDefinition.metadata.name}\n`,
        };
    }

    return files;
}

function normalizeFileDefinition(fileName: string, fileDefinition: unknown, defaultFormat = 'csv'): OutputFileDefinition {
    if (!fileDefinition || typeof fileDefinition !== 'object' || Array.isArray(fileDefinition)) {
        throw new Error(`files.${fileName} must be an object`);
    }

    const definition = fileDefinition as OutputFileDefinition;

    const format = String(definition.format ?? defaultFormat).toLowerCase();
    const { group, mode, content, includeHeader, ...fieldDefinitions } = definition;

    if (format === 'txt') {
        if (content === undefined) {
            throw new Error(`files.${fileName}.content is required for txt format`);
        }

        if (typeof content !== 'string') {
            throw new Error(`files.${fileName}.content must be a string`);
        }

        return {
            format: 'txt',
            content,
        };
    }

    const normalizedFields = normalizeRecordLayout(fileName, fieldDefinitions);

    return {
        format: 'csv',
        ...(group !== undefined ? { group } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(includeHeader !== undefined ? { includeHeader } : {}),
        ...normalizedFields,
    };
}

function normalizeOutputDefinition(recordType: string, definition: unknown): unknown {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        return definition;
    }

    const typedDefinition = definition as Record<string, unknown>;
    const { group, mode, includeHeader, ...fieldDefinitions } = typedDefinition;
    const normalizedFields = normalizeRecordLayout(recordType, fieldDefinitions);

    return {
        ...(group !== undefined ? { group } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(includeHeader !== undefined ? { includeHeader } : {}),
        ...normalizedFields,
    };
}

function normalizeRecordLayout(recordType: string, fieldDefinitions: unknown): Record<string, unknown> {
    if (!fieldDefinitions || typeof fieldDefinitions !== 'object' || Array.isArray(fieldDefinitions)) {
        return fieldDefinitions as Record<string, unknown>;
    }

    const normalizedFields: Record<string, unknown> = {};
    const typedFieldDefinitions = fieldDefinitions as Record<string, unknown>;
    const repeatKey = getRepeatKey(typedFieldDefinitions);

    for (const [fieldName, fieldDefinition] of Object.entries(typedFieldDefinitions)) {
        if (fieldName === repeatKey) {
            if (!Array.isArray(fieldDefinition)) {
                throw new Error(`${recordType}.${repeatKey} must be an array`);
            }

            for (const [sectionIndex, repeatDefinition] of fieldDefinition.entries()) {
                Object.assign(normalizedFields, expandRepeatSection(recordType, repeatKey, sectionIndex, repeatDefinition));
            }

            continue;
        }

        normalizedFields[fieldName] = fieldDefinition;
    }

    return normalizedFields;
}

function getRepeatKey(fieldDefinitions: Record<string, unknown>): string | null {
    const supportedKeys = ['repeat', 'repeating'];
    const foundKeys = supportedKeys.filter((key) => Object.prototype.hasOwnProperty.call(fieldDefinitions, key));

    if (foundKeys.length > 1) {
        throw new Error('Only one repeating section key is allowed: repeat or repeating');
    }

    return foundKeys[0] ?? null;
}

function expandRepeatSection(
    recordType: string,
    repeatKey: string,
    sectionIndex: number,
    sectionDefinition: unknown,
): Record<string, unknown> {
    if (!sectionDefinition || typeof sectionDefinition !== 'object' || Array.isArray(sectionDefinition)) {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}] must be an object`);
    }

    const section = sectionDefinition as RepeatSectionDefinition;

    const prefix = section.prefix;
    if (!prefix || typeof prefix !== 'string') {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}].prefix is required and must be a string`);
    }

    const start = section.start === undefined ? 1 : Number(section.start);
    if (!Number.isInteger(start)) {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}].start must be an integer`);
    }

    let size;
    if (section.size !== undefined) {
        size = Number(section.size);
    }

    if (section.end !== undefined) {
        const end = Number(section.end);

        if (!Number.isInteger(end) || end < start) {
            throw new Error(`${recordType}.${repeatKey}[${sectionIndex}].end must be an integer >= start`);
        }

        if (size !== undefined && (!Number.isInteger(size) || size !== end - start + 1)) {
            throw new Error(`${recordType}.${repeatKey}[${sectionIndex}] has conflicting size and end`);
        }

        size = end - start + 1;
    }

    if (size === undefined) {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}] must define size or end`);
    }

    if (!Number.isInteger(size) || size < 0) {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}].size must be a non-negative integer`);
    }

    const sectionFields = section.fields ?? {};
    if (!sectionFields || typeof sectionFields !== 'object' || Array.isArray(sectionFields)) {
        throw new Error(`${recordType}.${repeatKey}[${sectionIndex}].fields must be an object`);
    }

    const namedFields = Object.entries(sectionFields);
    if (namedFields.length > size) {
        throw new Error(
            `${recordType}.${repeatKey}[${sectionIndex}] defines ${namedFields.length} fields, which exceeds the configured size of ${size}`,
        );
    }

    const expandedSection = Object.fromEntries(namedFields) as Record<string, unknown>;
    const nextGenericIndex = start + namedFields.length;

    return {
        ...expandedSection,
        ...buildDefaultRepeatingFields(prefix, start, size, nextGenericIndex),
    };
}

function buildDefaultRepeatingFields(prefix: string, start: number, size: number, nextIndex: number): Record<string, string> {
    const defaultFields: Record<string, string> = {};
    const endIndex = start + size - 1;

    for (let index = nextIndex; index <= endIndex; index += 1) {
        defaultFields[`${prefix}${index}`] = '';
    }

    return defaultFields;
}

// Load file content from blob storage with the given filename
async function loadFileFromObjectStorage(filename: string, bucketName: string, namespaceName: string): Promise<ObjectStorageFile> {
    if (!filename) {
        throw new Error('filename is required');
    }

    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to load a file from Object Storage');
    }

    // Reuse the cached SDK client so repeated downloads do not rebuild it.
    const client = await getObjectStorageClient();

    // Download the object bytes by filename from the target bucket.
    const response = await client.getObject({
        namespaceName,
        bucketName,
        objectName: filename,
    });

    return {
        filename,
        bucketName,
        namespaceName,
        contentType: response.contentType,
        // Convert the SDK response body into a Buffer so callers get one stable
        // binary representation.
        content: await bodyToBuffer(response.value),
    };
}

// Convert a Node.js readable stream into a Buffer.
//
// OCI's Object Storage SDK can return object bodies as streams, so this helper
// collects each chunk and joins them into a single Buffer that later parsers can
// work with consistently.
function readableToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];

        // Collect every chunk as binary data so the full object body can be
        // reconstructed once the stream ends.
        readable.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        readable.on('error', reject);
        // Join all chunks into one Buffer when the stream is complete.
        readable.on('end', () => {
            resolve(Buffer.concat(chunks));
        });
    });
}

// Normalize different possible SDK/body response types into a Buffer.
//
// The rest of this module assumes file content is binary data in memory.
// Depending on runtime and SDK behavior, the downloaded body may already be a
// Buffer, a Uint8Array, a fetch-style body, or a Node stream. This helper hides
// those differences from the parsing functions.
async function bodyToBuffer(value: unknown): Promise<Buffer> {
    // Treat a missing body as an empty file so downstream code receives a
    // consistent type.
    if (!value) {
        return Buffer.alloc(0);
    }

    // Already in the desired form.
    if (Buffer.isBuffer(value)) {
        return value;
    }

    // Convert typed-array style binary data into a Node Buffer.
    if (value instanceof Uint8Array) {
        return Buffer.from(value);
    }

    // Handle Blob-like or fetch Response body helpers that expose arrayBuffer().
    if (typeof (value as Partial<ArrayBufferBody>).arrayBuffer === 'function') {
        return Buffer.from(await (value as ArrayBufferBody).arrayBuffer());
    }

    // Handle WHATWG ReadableStream bodies by pulling chunks manually.
    if (typeof (value as Partial<StreamReaderBody>).getReader === 'function') {
        const reader = (value as StreamReaderBody).getReader();
        const chunks: Buffer[] = [];

        while (true) {
            const { done, value: chunk } = await reader.read();

            if (done) {
                break;
            }

            chunks.push(Buffer.from(chunk!));
        }

        return Buffer.concat(chunks);
    }

    // Handle classic Node.js readable streams.
    if (typeof (value as Partial<NodeJS.ReadableStream>).on === 'function') {
        return readableToBuffer(value as NodeJS.ReadableStream);
    }

    // If OCI SDK behavior changes to an unexpected body type, throw an error
    throw new Error('Unsupported Object Storage response body type');
}

// Convert a worksheet-like 2D array into the project's normalized row format.
//
function normalizeWorksheetStructure(structure: StructureOptions = {}): NormalizedWorksheetStructure {
    return {
        headerRowPresent: structure?.headerRowPresent === true,
        ignoreHeaderRow: structure?.ignoreHeaderRow === true,
    };
}

function getColumnNames(matrix: unknown[][], structure?: StructureOptions): string[] {
    const { headerRowPresent, ignoreHeaderRow } = normalizeWorksheetStructure(structure);
    const dataRows = matrix.filter((row) => Array.isArray(row));
    const dataStartIndex = headerRowPresent ? 1 : 0;
    const maxColumns = dataRows.slice(dataStartIndex).reduce((currentMax, row) => Math.max(currentMax, row.length), 0);

    if (headerRowPresent && !ignoreHeaderRow) {
        const headerRow = Array.isArray(dataRows[0]) ? dataRows[0] : [];
        const columnCount = Math.max(headerRow.length, maxColumns);

        return Array.from({ length: columnCount }, (_, index) => {
            const headerValue = headerRow[index];
            return headerValue == null || String(headerValue).trim() === '' ? `C${index + 1}` : String(headerValue);
        });
    }

    return Array.from({ length: maxColumns }, (_, index) => `C${index + 1}`);
}

function buildTabularFile(filename: string, rows: TabularRow[]): TabularFile {
    return {
        filename,
        basename: path.posix.basename(filename),
        rows,
    };
}

// Convert worksheet rows into the normalized structure expected by the splitting
// layer. Depending on the config YAML, rows can either use positional C1..Cn
// keys or the first row's header values as property names.
function mapRowsToColumns(matrix: unknown[][], structure?: StructureOptions): TabularRow[] {
    const { headerRowPresent, ignoreHeaderRow } = normalizeWorksheetStructure(structure);
    const worksheetRows = matrix.filter((row) => Array.isArray(row));
    const columnNames = getColumnNames(worksheetRows, structure);
    const dataStartIndex = headerRowPresent ? 1 : 0;
    const dataRows = worksheetRows.slice(dataStartIndex);

    return dataRows
        .map((row) => {
            const mappedRow: TabularRow = {};

            for (const [index, columnName] of columnNames.entries()) {
                const value = row[index];
                mappedRow[columnName] = value == null ? '' : String(value);
            }

            return mappedRow;
        })
        .filter((row) => Object.values(row).some((value) => value !== ''));
}

// Parse CSV/XLS/XLSX content into the shared normalized structure.
//
// This function:
// 1. Reads the workbook from a Buffer.
// 2. Selects the first worksheet only.
// 3. Converts the sheet to a 2D array.
// 4. Delegates to mapRowsToColumns to skip headers and assign C1..Cn keys.
function parseWorksheetBuffer(filename: string, content: Buffer, structure?: StructureOptions): TabularFile {
    const workbook = XLSX.read(content, {
        type: 'buffer',
    });

    // Use the first sheet as the structured input source.
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];

    // Convert the sheet into row arrays so we can ignore the first row and map
    // the rest into positional columns.
    const matrix = XLSX.utils.sheet_to_json(firstSheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
    }) as unknown[][];

    return {
        ...buildTabularFile(filename, mapRowsToColumns(matrix, structure)),
    };
}

// Normalize JSON files into the same outer wrapper used for spreadsheet files.
//
// Supported JSON shapes:
// - an array of rows
// - an object that already contains a rows array
// - any other JSON value, wrapped as a single row payload
function normalizeJsonDocument(filename: string, parsedJson: unknown): TabularFile {
    if (Array.isArray(parsedJson)) {
        return buildTabularFile(filename, parsedJson as TabularRow[]);
    }

    if (parsedJson && typeof parsedJson === 'object' && Array.isArray((parsedJson as any).rows)) {
        const parsedObject = parsedJson as Record<string, unknown> & { rows: TabularRow[] };
        return {
            ...parsedObject,
            ...buildTabularFile(filename, parsedObject.rows),
        };
    }

    return buildTabularFile(filename, [parsedJson as TabularRow]);
}

function buildCsvBuffer(rows: Array<Record<string, unknown>>, includeHeader = true): Buffer {
    const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csvLines: string[] = [];

    if (includeHeader && columnNames.length > 0) {
        csvLines.push(columnNames.map(escapeCsvValue).join(','));
    }

    for (const row of rows) {
        csvLines.push(columnNames.map((columnName) => escapeCsvValue(row[columnName] ?? '')).join(','));
    }

    return Buffer.from(`${csvLines.join('\n')}${csvLines.length > 0 ? '\n' : ''}`, 'utf8');
}

function escapeCsvValue(value: unknown): string {
    const stringValue = String(value);

    if (!/[",\n\r]/.test(stringValue)) {
        return stringValue;
    }

    return `"${stringValue.replace(/"/g, '""')}"`;
}

async function uploadObjectToObjectStorage(
    normalizedOutputDirectory: string,
    zipFileName: string,
    content: Buffer,
    contentType: string,
    bucketName: string,
    namespaceName: string,
): Promise<void> {
    if (namespaceName == 'localtest') {
        const filePath = path.join(normalizedOutputDirectory, zipFileName);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, content);
    } else {
        const client = await getObjectStorageClient();
        const objectName = `${normalizedOutputDirectory}${zipFileName}`

        await client.putObject({
            namespaceName,
            bucketName,
            objectName,
            contentType,
            contentLength: content.length,
            putObjectBody: content,
        });
    }    
}

async function saveZippedOutputFiles(
    outputDirectory: string,
    outputFiles: GeneratedOutputFile[],
    bucketName: string,
    namespaceName: string,
    inputObjectName: string,
): Promise<void> {
    if (!outputDirectory) {
        throw new Error('outputDirectory is required');
    }

    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save output files to Object Storage');
    }

    if (!inputObjectName || typeof inputObjectName !== 'string') {
        throw new Error('inputObjectName is required to compute the output zip filename');
    }

    if (!Array.isArray(outputFiles) || outputFiles.length === 0) {
        throw new Error('At least one output file is required to save zipped output files');
    }

    const normalizedOutputDirectory = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;
    const zip = new JSZip();

    for (const file of outputFiles) {
        if (!file.name) {
            throw new Error('Each output file must include a name');
        }

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

    const zipContent = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
    });

    const zipFileName = buildTimestampedZipName(inputObjectName);

    await uploadObjectToObjectStorage(
        normalizedOutputDirectory,
        zipFileName,
        zipContent,
        'application/zip',
        bucketName,
        namespaceName,
    );
}

function buildTimestampedZipName(inputObjectName: string): string {
    const fileName = path.basename(inputObjectName, path.extname(inputObjectName));
    const timestamp = dayjs().format('YYYYMMDDHHmmss');
    return `${fileName}_${timestamp}.zip`;
}

async function saveTriggerFile(outputDirectory: string, bucketName: string, namespaceName: string): Promise<void> {
    if (!outputDirectory) {
        throw new Error('outputDirectory is required');
    }

    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save the trigger file');
    }

    const normalizedOutputDirectory = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;

    await uploadObjectToObjectStorage(
        normalizedOutputDirectory,
        'done.trg',
        Buffer.alloc(0),
        'text/plain',
        bucketName,
        namespaceName,
    );
}

export { loadTabularFile as loadStructuredFile, loadConfigFile, normalizeConfigDefinition, saveZippedOutputFiles, saveTriggerFile };