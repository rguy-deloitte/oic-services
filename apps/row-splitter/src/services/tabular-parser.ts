import path from 'node:path';
import * as XLSX from 'xlsx';

export type TabularRow = Record<string, string>;
type WorksheetCell = string | number | boolean | null | undefined;
type WorksheetMatrix = WorksheetCell[][];

export interface TabularFile {
    filename: string;
    basename: string;
    rows: TabularRow[];
}

export interface StructureOptions {
    headerRowPresent?: boolean;
    ignoreHeaderRow?: boolean;
}

interface NormalizedWorksheetStructure {
    headerRowPresent: boolean;
    ignoreHeaderRow: boolean;
}

function normalizeWorksheetStructure(structure: StructureOptions = {}): NormalizedWorksheetStructure {
    return {
        headerRowPresent: structure.headerRowPresent === true,
        ignoreHeaderRow: structure.ignoreHeaderRow === true,
    };
}

function buildTabularFile(filename: string, rows: TabularRow[]): TabularFile {
    return {
        filename,
        basename: path.posix.basename(filename),
        rows,
    };
}

function getColumnNames(matrix: WorksheetMatrix, structure?: StructureOptions): string[] {
    const { headerRowPresent, ignoreHeaderRow } = normalizeWorksheetStructure(structure);
    const dataRows = matrix.filter((row) => Array.isArray(row));
    const dataStartIndex = headerRowPresent ? 1 : 0;
    const maxColumns = dataRows
        .slice(dataStartIndex)
        .reduce((currentMax, row) => Math.max(currentMax, row.length), 0);

    if (headerRowPresent && !ignoreHeaderRow) {
        const headerRow = Array.isArray(dataRows[0]) ? dataRows[0] : [];
        const columnCount = Math.max(headerRow.length, maxColumns);
        return Array.from({ length: columnCount }, (_, index) => {
            const headerValue = headerRow[index];
            return headerValue == null || String(headerValue).trim() === ''
                ? `C${index + 1}`
                : String(headerValue);
        });
    }

    return Array.from({ length: maxColumns }, (_, index) => `C${index + 1}`);
}

function mapRowsToColumns(matrix: WorksheetMatrix, structure?: StructureOptions): TabularRow[] {
    const { headerRowPresent } = normalizeWorksheetStructure(structure);
    const worksheetRows = matrix.filter((row) => Array.isArray(row));
    const columnNames = getColumnNames(worksheetRows, structure);
    const dataStartIndex = headerRowPresent ? 1 : 0;

    return worksheetRows
        .slice(dataStartIndex)
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

export function parseWorksheetBuffer(
    filename: string,
    content: Buffer,
    structure?: StructureOptions,
): TabularFile {
    const workbook = XLSX.read(content, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];
    const matrix = XLSX.utils.sheet_to_json(firstSheet, {
        header: 1,
        raw: false,
        defval: '',
        blankrows: false,
    }) as WorksheetMatrix;
    return buildTabularFile(filename, mapRowsToColumns(matrix, structure));
}
