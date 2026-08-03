const fs = require('node:fs').promises;
const path = require('node:path');
const { XMLParser } = require('fast-xml-parser');
const common = require('oci-common');
const objectStorage = require('oci-objectstorage');

// Parser config: preserve attributes (including xmlns), keep all values as
// strings to avoid coercing numeric-looking values like account IDs.
// ignoreDeclaration strips the <?xml?> processing node from the parsed object
// so we can emit it cleanly ourselves during build.
const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    ignoreDeclaration: true,
});

let objectStorageClientPromise;

function getObjectStorageClient() {
    if (!objectStorageClientPromise) {
        objectStorageClientPromise = (async () => {
            const provider = await common.ResourcePrincipalAuthenticationDetailsProvider.builder();
            return new objectStorage.ObjectStorageClient({ authenticationDetailsProvider: provider });
        })();
    }

    return objectStorageClientPromise;
}

// Loads a raw file from local disk or Object Storage and returns a Buffer.
async function loadRawFile(filePath, bucketName, namespaceName) {
    if (namespaceName === 'localtest') {
        return fs.readFile(filePath);
    }

    const client = await getObjectStorageClient();
    const response = await client.getObject({
        namespaceName,
        bucketName,
        objectName: filePath,
    });

    const chunks = [];
    for await (const chunk of response.value) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
}

function stripFormattingTextNodes(node) {
    if (Array.isArray(node)) {
        for (const item of node) {
            stripFormattingTextNodes(item);
        }

        return;
    }

    if (!node || typeof node !== 'object') {
        return;
    }

    if (Object.prototype.hasOwnProperty.call(node, '#text')) {
        const textValue = node['#text'];

        if (typeof textValue === 'string' && textValue.trim() === '') {
            delete node['#text'];
        }
    }

    for (const value of Object.values(node)) {
        stripFormattingTextNodes(value);
    }
}

// Loads an XML file and returns it as a raw string (original formatting kept).
async function loadXmlTextFile(filePath, bucketName, namespaceName) {
    const buffer = await loadRawFile(filePath, bucketName, namespaceName);
    return buffer.toString('utf8');
}

// Parses XML text for validation checks.
function parseXmlText(xmlText) {
    const parsedXml = xmlParser.parse(xmlText);
    stripFormattingTextNodes(parsedXml);
    return parsedXml;
}

// Loads an XML file and returns the parsed JS object representation.
async function loadXmlFile(filePath, bucketName, namespaceName) {
    const xmlText = await loadXmlTextFile(filePath, bucketName, namespaceName);
    return parseXmlText(xmlText);
}

// Saves XML text exactly as provided.
async function saveXmlTextFile(outputPath, xmlText, bucketName, namespaceName) {
    if (namespaceName === 'localtest') {
        await fs.mkdir(path.dirname(outputPath), { recursive: true });
        await fs.writeFile(outputPath, xmlText, 'utf8');
        return;
    }

    const client = await getObjectStorageClient();
    const contentBytes = Buffer.from(xmlText, 'utf8');

    await client.putObject({
        namespaceName,
        bucketName,
        objectName: outputPath,
        putObjectBody: contentBytes,
        contentLength: contentBytes.length,
        contentType: 'application/xml',
    });
}

// Replaces versioned BkToCstmrStmt tags with BkToCstmrStmt while preserving
// everything else in the document.
function normalizeBkToCstmrStmtTag(xmlText) {
    return xmlText
        .replace(/<BkToCstmrStmt[^>\s]*(\s[^>]*)?>/g, '<BkToCstmrStmt$1>')
        .replace(/<\/BkToCstmrStmt[^>\s]*>/g, '</BkToCstmrStmt>');
}

function parseValDt(value) {
    if (!/^\d{6}$/.test(value)) {
        throw new Error(`Unsupported ValDt value: ${value}`);
    }

    const year = 2000 + Number.parseInt(value.slice(0, 2), 10);
    const month = Number.parseInt(value.slice(2, 4), 10);
    const day = Number.parseInt(value.slice(4, 6), 10);

    return createValidatedUtcDate(year, month, day, `ValDt value: ${value}`);
}

function parseBookgDtMonthDay(value) {
    if (!/^\d{4}$/.test(value)) {
        throw new Error(`Unsupported BookgDt value: ${value}`);
    }

    return {
        month: Number.parseInt(value.slice(0, 2), 10),
        day: Number.parseInt(value.slice(2, 4), 10),
    };
}

function createValidatedUtcDate(year, month, day, label) {
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        throw new Error(`Invalid ${label}`);
    }

    return date;
}

function formatUtcDate(date) {
    return [
        String(date.getUTCFullYear()).padStart(4, '0'),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

function resolveClosestBookgDt(bookgDtValue, valDtDate) {
    const { month, day } = parseBookgDtMonthDay(bookgDtValue);
    const candidateYears = [
        valDtDate.getUTCFullYear() - 1,
        valDtDate.getUTCFullYear(),
        valDtDate.getUTCFullYear() + 1,
    ];

    let closestDate = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const year of candidateYears) {
        const candidateDate = createValidatedUtcDate(year, month, day, `BookgDt value: ${bookgDtValue}`);
        const distance = Math.abs(candidateDate.getTime() - valDtDate.getTime());

        if (distance < closestDistance) {
            closestDate = candidateDate;
            closestDistance = distance;
        }
    }

    return closestDate;
}

function normalizeEntryDates(xmlText) {
    const entryDatePattern = /(<BookgDt>\s*<Dt>)(\d{4})(<\/Dt>\s*<\/BookgDt>\s*<ValDt>\s*<Dt>)(\d{6})(<\/Dt>\s*<\/ValDt>)/g;

    return xmlText.replace(entryDatePattern, (_, bookgOpen, bookgValue, middle, valValue, valClose) => {
        const valDtDate = parseValDt(valValue);
        const bookgDtDate = resolveClosestBookgDt(bookgValue, valDtDate);

        return `${bookgOpen}${formatUtcDate(bookgDtDate)}${middle}${formatUtcDate(valDtDate)}${valClose}`;
    });
}

module.exports = {
    loadXmlTextFile,
    parseXmlText,
    loadXmlFile,
    saveXmlTextFile,
    normalizeBkToCstmrStmtTag,
    normalizeEntryDates,
};
