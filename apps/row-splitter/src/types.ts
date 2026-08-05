export type TabularRow = Record<string, unknown>;

export interface TabularFile {
    filename: string;
    basename: string;
    rows: TabularRow[];
    [key: string]: unknown;
}

export interface StructureOptions {
    headerRowPresent?: boolean;
    ignoreHeaderRow?: boolean;
}

export type LookupMap = Record<string, unknown>;

export interface SequenceDefinition {
    type?: string;
    prefix?: string;
    start?: number;
    [key: string]: unknown;
}

export interface FieldDefinitionObject {
    value?: unknown;
    from?: string;
    fromRoot?: string;
    fromGroup?: string;
    sequence?: string | SequenceDefinition;
    expr?: string;
    lookup?: LookupMap;
    transform?: string;
    format?: string;
    [key: string]: unknown;
}

export type FieldDefinition = FieldDefinitionObject | string | number | boolean | null | undefined;

export interface OutputFileDefinition {
    format?: 'csv' | 'txt';
    group?: string;
    mode?: 'group' | 'row';
    includeHeader?: boolean;
    content?: string;
    [key: string]: unknown;
}

export interface MetadataDefinition {
    name?: string;
    version?: string | number;
    [key: string]: unknown;
}

export interface RowSplitterConfig {
    structure?: StructureOptions;
    files?: Record<string, OutputFileDefinition>;
    groups?: Record<string, unknown>;
    primaryGroup?: string;
    header?: OutputFileDefinition;
    line?: OutputFileDefinition;
    metadata?: MetadataDefinition;
    [key: string]: unknown;
}

export interface OutputCsvFile {
    name: string;
    format: 'csv';
    includeHeader: boolean;
    rows: Record<string, string>[];
}

export interface OutputTxtFile {
    name: string;
    format: 'txt';
    content: string;
}

export type GeneratedOutputFile = OutputCsvFile | OutputTxtFile;
