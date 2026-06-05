const path = require('node:path');
const common = require('oci-common');
const objectStorage = require('oci-objectstorage');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const yaml = require('yaml');

const FORMAT_SECTION_LAYOUTS = {
    header: {
        fixedFields: [
            'TRANSACTION_NUMBER',
            'EVENT_TYPE_CODE',
            'LEDGER_NAME',
            'TRANSACTION_DATE',
        ],
        typedSections: [
            { sectionName: 'Characters', defaultSize: 50 },
            { sectionName: 'Numbers', defaultSize: 10 },
            { sectionName: 'Dates', defaultSize: 10 },
            { sectionName: 'Long Characters', defaultSize: 5 },
        ],
    },
    line: {
        fixedFields: [
            'TRANSACTION_NUMBER',
            'LINE_NUMBER',
        ],
        typedSections: [
            { sectionName: 'Characters', defaultSize: 100 },
            { sectionName: 'Numbers', defaultSize: 30 },
            { sectionName: 'Dates', defaultSize: 10 },
            { sectionName: 'Long Characters', defaultSize: 5 },
        ],
    },
};

// Reuse a single OCI Object Storage client across invocations within the same
// function container. Caching the client avoids rebuilding the resource principal 
// provider for every file read/write
let objectStorageClientPromise;

// Build and cache the OCI Object Storage client used by loadFileFromObjectStorage.
function getObjectStorageClient() {
    if (!objectStorageClientPromise) {
        objectStorageClientPromise = (async () => {
            const authenticationDetailsProvider = await common.ResourcePrincipalAuthenticationDetailsProvider.builder();

            return new objectStorage.ObjectStorageClient({
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
async function loadStructuredFile(filename, bucketName, namespaceName, structure) {
    const extension = path.extname(filename).toLowerCase();
    const { content } = await loadFileFromObjectStorage(filename, bucketName, namespaceName);

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

// Loads a format file from object storage based on the path of the input file
async function loadFormatFile(filename, bucketName, namespaceName) {
    // Derive the format name from the input filename. Takes the folder name immediately preceding the file as the format
    // e.g. "formats/format1.yaml" for "input/format1/data.csv".
    const pathParts = filename.split(path.sep);
    if (pathParts.length < 2) {
        throw new Error(`Input filename must include at least one directory to determine format, got: ${filename}`);
    }
    const format = pathParts[pathParts.length - 2];

    const formatFilePath = `fbdi-splitting/formats/${format}.yaml`;

    const formatContent = await loadFileFromObjectStorage(formatFilePath, bucketName, namespaceName);

    return normalizeFormatDefinition(yaml.parse(formatContent.content.toString('utf8')));
}

function normalizeFormatDefinition(formatDefinition) {
    if (!formatDefinition || typeof formatDefinition !== 'object' || Array.isArray(formatDefinition)) {
        return formatDefinition;
    }

    return {
        ...formatDefinition,
        header: normalizeRecordLayout('header', formatDefinition.header),
        line: normalizeRecordLayout('line', formatDefinition.line),
    };
}

function normalizeRecordLayout(recordType, fieldDefinitions) {
    if (!fieldDefinitions || typeof fieldDefinitions !== 'object' || Array.isArray(fieldDefinitions)) {
        return fieldDefinitions;
    }

    const layout = FORMAT_SECTION_LAYOUTS[recordType];

    if (!layout) {
        return fieldDefinitions;
    }

    const typedSectionNames = layout.typedSections.map((section) => section.sectionName);
    const allowedTopLevelFields = new Set([...layout.fixedFields, ...typedSectionNames]);
    const unexpectedFields = Object.keys(fieldDefinitions).filter((fieldName) => !allowedTopLevelFields.has(fieldName));

    if (unexpectedFields.length > 0) {
        throw new Error(
            `${recordType} must only contain fixed fields plus section blocks. Unsupported top-level fields: ${unexpectedFields.join(', ')}`,
        );
    }

    const normalizedFields = {};

    for (const fixedField of layout.fixedFields) {
        normalizedFields[fixedField] = fieldDefinitions[fixedField] ?? '';
    }

    for (const sectionLayout of layout.typedSections) {
        Object.assign(
            normalizedFields,
            expandTypedSection(recordType, sectionLayout, fieldDefinitions[sectionLayout.sectionName]),
        );
    }

    return normalizedFields;
}

function expandTypedSection(recordType, sectionLayout, sectionDefinition) {
    const fieldPrefix = getFieldPrefix(sectionLayout.sectionName);

    if (sectionDefinition === undefined) {
        return buildDefaultTypedFields(fieldPrefix, sectionLayout.defaultSize, 1);
    }

    if (!sectionDefinition || typeof sectionDefinition !== 'object' || Array.isArray(sectionDefinition)) {
        throw new Error(`${recordType}.${sectionLayout.sectionName} must be an object`);
    }

    const requestedSize = sectionDefinition.size;
    const size = requestedSize === undefined ? sectionLayout.defaultSize : Number(requestedSize);

    if (!Number.isInteger(size) || size < 0) {
        throw new Error(`${recordType}.${sectionLayout.sectionName}.size must be a non-negative integer`);
    }

    const namedFields = Object.entries(sectionDefinition).filter(([fieldName]) => fieldName !== 'size');

    if (namedFields.length > size) {
        throw new Error(
            `${recordType}.${sectionLayout.sectionName} defines ${namedFields.length} fields, which exceeds the configured size of ${size}`,
        );
    }

    const expandedSection = Object.fromEntries(namedFields);
    const nextGenericIndex = namedFields.length + 1;

    return {
        ...expandedSection,
        ...buildDefaultTypedFields(fieldPrefix, size, nextGenericIndex),
    };
}

function getFieldPrefix(sectionName) {
    return sectionName.endsWith('s') ? sectionName.slice(0, -1) : sectionName;
}

function buildDefaultTypedFields(fieldPrefix, size, startIndex) {
    const defaultFields = {};

    for (let index = startIndex; index <= size; index += 1) {
        defaultFields[`${fieldPrefix}${index}`] = '';
    }

    return defaultFields;
}

// Load file content from blob storage with the given filename
async function loadFileFromObjectStorage(filename, bucketName, namespaceName) {
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
function readableToBuffer(readable) {
    return new Promise((resolve, reject) => {
        const chunks = [];

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
async function bodyToBuffer(value) {
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
    if (typeof value.arrayBuffer === 'function') {
        return Buffer.from(await value.arrayBuffer());
    }

    // Handle WHATWG ReadableStream bodies by pulling chunks manually.
    if (typeof value.getReader === 'function') {
        const reader = value.getReader();
        const chunks = [];

        while (true) {
            const { done, value: chunk } = await reader.read();

            if (done) {
                break;
            }

            chunks.push(Buffer.from(chunk));
        }

        return Buffer.concat(chunks);
    }

    // Handle classic Node.js readable streams.
    if (typeof value.on === 'function') {
        return readableToBuffer(value);
    }

    // If OCI SDK behavior changes to an unexpected body type, throw an error
    throw new Error('Unsupported Object Storage response body type');
}

// Convert a worksheet-like 2D array into the project's normalized row format.
//
function normalizeWorksheetStructure(structure = {}) {
    return {
        headerRowPresent: structure?.headerRowPresent === true,
        ignoreHeaderRow: structure?.ignoreHeaderRow === true,
    };
}

function getColumnNames(matrix, structure) {
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

function buildStructuredFile(filename, rows) {
    return {
        filename,
        basename: path.posix.basename(filename),
        rows,
    };
}

// Convert worksheet rows into the normalized structure expected by the splitting
// layer. Depending on the format YAML, rows can either use positional C1..Cn
// keys or the first row's header values as property names.
function mapRowsToColumns(matrix, structure) {
    const { headerRowPresent, ignoreHeaderRow } = normalizeWorksheetStructure(structure);
    const worksheetRows = matrix.filter((row) => Array.isArray(row));
    const columnNames = getColumnNames(worksheetRows, structure);
    const dataStartIndex = headerRowPresent ? 1 : 0;
    const dataRows = worksheetRows.slice(dataStartIndex);

    return dataRows
        .map((row) => {
            const mappedRow = {};

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
function parseWorksheetBuffer(filename, content, structure) {
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
    });

    return {
        ...buildStructuredFile(filename, mapRowsToColumns(matrix, structure)),
    };
}

// Normalize JSON files into the same outer wrapper used for spreadsheet files.
//
// Supported JSON shapes:
// - an array of rows
// - an object that already contains a rows array
// - any other JSON value, wrapped as a single row payload
function normalizeJsonDocument(filename, parsedJson) {
    if (Array.isArray(parsedJson)) {
        return buildStructuredFile(filename, parsedJson);
    }

    if (parsedJson && typeof parsedJson === 'object' && Array.isArray(parsedJson.rows)) {
        return {
            ...parsedJson,
            ...buildStructuredFile(filename, parsedJson.rows),
        };
    }

    return buildStructuredFile(filename, [parsedJson]);
}

function buildCsvBuffer(rows) {
    const columnNames = rows.length > 0 ? Object.keys(rows[0]) : [];
    const csvLines = [columnNames.map(escapeCsvValue).join(',')];

    for (const row of rows) {
        csvLines.push(columnNames.map((columnName) => escapeCsvValue(row[columnName] ?? '')).join(','));
    }

    return Buffer.from(`${csvLines.join('\n')}\n`, 'utf8');
}

function escapeCsvValue(value) {
    const stringValue = String(value);

    if (!/[",\n\r]/.test(stringValue)) {
        return stringValue;
    }

    return `"${stringValue.replace(/"/g, '""')}"`;
}

async function uploadObjectToObjectStorage(objectName, content, contentType, bucketName, namespaceName) {
    const client = await getObjectStorageClient();

    await client.putObject({
        namespaceName,
        bucketName,
        objectName,
        contentType,
        contentLength: content.length,
        putObjectBody: content,
    });
}

async function saveZippedOutputFiles(outputDirectory, headers, lines, metadata, bucketName, namespaceName) {
    if (!outputDirectory) {
        throw new Error('outputDirectory is required');
    }

    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save output files to Object Storage');
    }

    if (!metadata || !metadata.name || !metadata.version) {
        throw new Error('metadata with name and version is required to save output files');
    }

    const normalizedOutputDirectory = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;
    const zip = new JSZip();

    zip.file('XlaTrxH.csv', buildCsvBuffer(headers));
    zip.file('XlaTrxL.csv', buildCsvBuffer(lines));

    const metadataContent = `Metadata version number : ${metadata.version}\nApplication Short Name : ${metadata.name}\n`;

    zip.file(`Metadata_${metadata.name}.txt`, metadataContent);

    const zipContent = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
    });

    await uploadObjectToObjectStorage(
        `${normalizedOutputDirectory}XlaTransactionUpload.zip`,
        zipContent,
        'application/zip',
        bucketName,
        namespaceName,
    );
}

async function saveTriggerFile(outputDirectory, bucketName, namespaceName) {
    if (!outputDirectory) {
        throw new Error('outputDirectory is required');
    }

    if (!bucketName || !namespaceName) {
        throw new Error('bucketName and namespaceName are required to save the trigger file');
    }

    const normalizedOutputDirectory = outputDirectory.endsWith('/') ? outputDirectory : `${outputDirectory}/`;

    await uploadObjectToObjectStorage(
        `${normalizedOutputDirectory}done.trg`,
        Buffer.alloc(0),
        'text/plain',
        bucketName,
        namespaceName,
    );
}

module.exports = {
    loadStructuredFile,
    loadFormatFile,
    normalizeFormatDefinition,
    saveZippedOutputFiles,
    saveTriggerFile,
};