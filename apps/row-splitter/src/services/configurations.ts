import type { StructureOptions } from './tabular-parser.js';
import type { FieldDefinition, FieldDefinitionObject } from './field-resolver.js';

export interface GroupSequenceInput {
    sequence?: {
        prefix?: string;
        start?: number | string;
    };
    prefix?: string;
    start?: number | string;
}

export interface GroupKeyFormatInput {
    format: string;
    sequenceStart?: number | string;
}

export type GroupKeyDefinition = GroupSequenceInput | GroupKeyFormatInput;

export interface GroupDefinition {
    groupBy: string[];
    key?: GroupKeyDefinition;
    count?: GroupSequenceInput;
}

export interface OutputFileDefinition {
    format?: 'csv' | 'txt';
    onePer?: string;
    includeHeader?: boolean;
    content?: string;
    [key: string]: FieldDefinition | string | boolean | undefined;
}

export interface ZipOutputDefinition {
    name?: string;
    format?: string;
}

export interface OutputFileSettings {
    zip?: ZipOutputDefinition;
    [key: string]: string | ZipOutputDefinition | undefined;
}

export interface RowSplitterConfig {
    configVersion?: string | number;
    sourceFile?: StructureOptions;
    outputFile?: OutputFileSettings;
    files?: Record<string, OutputFileDefinition>;
    groups?: Record<string, GroupDefinition>;
}

function isFieldDefinitionObject(value: FieldDefinition | string | boolean | undefined): value is FieldDefinitionObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSourceFileDefinition(sourceFileDefinition: unknown): StructureOptions | undefined {
    if (sourceFileDefinition === undefined) {
        return undefined;
    }

    if (!sourceFileDefinition || typeof sourceFileDefinition !== 'object' || Array.isArray(sourceFileDefinition)) {
        throw new Error('sourceFile must be an object');
    }

    return sourceFileDefinition as StructureOptions;
}

function validateZipFormat(format: string): void {
    const placeholderMatches = format.match(/\{[^}]+\}/g) ?? [];
    const allowedPlaceholders = new Set(['{inputName}', '{timestamp}']);

    for (const placeholder of placeholderMatches) {
        if (!allowedPlaceholders.has(placeholder)) {
            throw new Error(`outputFile.zip.format contains an unsupported placeholder: ${placeholder}`);
        }
    }

    if (!format.endsWith('.zip')) {
        throw new Error('outputFile.zip.format must produce a .zip filename');
    }
}

function normalizeZipOutputDefinition(zipDefinition: unknown): ZipOutputDefinition {
    if (!zipDefinition || typeof zipDefinition !== 'object' || Array.isArray(zipDefinition)) {
        throw new Error('outputFile.zip must be an object');
    }

    const zip = zipDefinition as ZipOutputDefinition;
    const hasName = zip.name !== undefined;
    const hasFormat = zip.format !== undefined;

    if (hasName && hasFormat) {
        throw new Error('outputFile.zip.name and outputFile.zip.format cannot both be provided');
    }
    if (!hasName && !hasFormat) {
        throw new Error('outputFile.zip must include either name or format');
    }

    if (hasName) {
        if (typeof zip.name !== 'string' || zip.name.trim() === '') {
            throw new Error('outputFile.zip.name must be a non-empty string');
        }
        if (!zip.name.endsWith('.zip')) {
            throw new Error('outputFile.zip.name must end with .zip');
        }
        return { name: zip.name };
    }

    if (typeof zip.format !== 'string' || zip.format.trim() === '') {
        throw new Error('outputFile.zip.format must be a non-empty string');
    }
    validateZipFormat(zip.format);
    return { format: zip.format };
}

function normalizeOutputFileSettings(outputFileDefinition: unknown): OutputFileSettings | undefined {
    if (outputFileDefinition === undefined) {
        return undefined;
    }

    if (!outputFileDefinition || typeof outputFileDefinition !== 'object' || Array.isArray(outputFileDefinition)) {
        throw new Error('outputFile must be an object');
    }

    const normalizedOutputFile: OutputFileSettings = {};

    for (const [key, value] of Object.entries(outputFileDefinition)) {
        if (key === 'zip') {
            normalizedOutputFile.zip = normalizeZipOutputDefinition(value);
            continue;
        }

        if (typeof value !== 'string') {
            throw new Error(`outputFile.${key} must be a string`);
        }
        normalizedOutputFile[key] = value;
    }

    return normalizedOutputFile;
}

function normalizeFilesDefinition(filesDefinition: unknown): Record<string, OutputFileDefinition> | undefined {
    if (filesDefinition === undefined) {
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

function parseFromGroupReference(
    fileName: string,
    fieldName: string,
    fromGroup: unknown,
): { groupName: string; generatedValue: 'key' | 'count' } {
    if (typeof fromGroup !== 'string' || fromGroup.trim() === '') {
        throw new Error(`files.${fileName}.${fieldName}.fromGroup must be a non-empty string`);
    }

    const parts = fromGroup.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(
            `files.${fileName}.${fieldName}.fromGroup must include an explicit group name, for example groupName.key`,
        );
    }

    const [groupName, generatedValue] = parts;
    if (generatedValue !== 'key' && generatedValue !== 'count') {
        throw new Error(`files.${fileName}.${fieldName}.fromGroup must end with .key or .count`);
    }

    return { groupName, generatedValue };
}

function getGroupDefinition(
    groupsDefinition: RowSplitterConfig['groups'],
    contextPath: string,
    groupName: string,
): GroupDefinition {
    if (!groupsDefinition) {
        throw new Error(`Config file must define groups when ${contextPath} is used`);
    }

    const groupDefinition = groupsDefinition[groupName];
    if (!groupDefinition || typeof groupDefinition !== 'object' || Array.isArray(groupDefinition)) {
        throw new Error(`${contextPath} must reference one of the configured groups: ${Object.keys(groupsDefinition).join(', ')}`);
    }

    return groupDefinition as GroupDefinition;
}

function validateFromGroupReference(
    fileName: string,
    fieldName: string,
    fromGroup: unknown,
    groupsDefinition: RowSplitterConfig['groups'],
): void {
    const { groupName, generatedValue } = parseFromGroupReference(fileName, fieldName, fromGroup);
    const groupDefinition = getGroupDefinition(
        groupsDefinition,
        `files.${fileName}.${fieldName}.fromGroup`,
        groupName,
    );

    if (!groupDefinition[generatedValue]) {
        throw new Error(`groups.${groupName}.${generatedValue} must be defined when files.${fileName}.${fieldName}.fromGroup uses ${groupName}.${generatedValue}`);
    }
}

function validateFileFieldDefinitions(
    fileName: string,
    definition: OutputFileDefinition,
    groupsDefinition: RowSplitterConfig['groups'],
): void {
    for (const [fieldName, fieldDefinition] of Object.entries(definition)) {
        if (fieldName === 'format' || fieldName === 'onePer' || fieldName === 'includeHeader' || fieldName === 'content') {
            continue;
        }

        if (isFieldDefinitionObject(fieldDefinition) && Object.prototype.hasOwnProperty.call(fieldDefinition, 'fromGroup')) {
            validateFromGroupReference(
                fileName,
                fieldName,
                fieldDefinition.fromGroup,
                groupsDefinition,
            );
        }
    }
}

function validateFilesAgainstGroups(
    filesDefinition: Record<string, OutputFileDefinition>,
    groupsDefinition: RowSplitterConfig['groups'],
): void {
    for (const [fileName, fileDefinition] of Object.entries(filesDefinition)) {
        if (fileDefinition.format === 'txt') {
            if (fileDefinition.onePer !== undefined) {
                throw new Error(`files.${fileName}.onePer cannot be used with txt format`);
            }
            continue;
        }

        if (fileDefinition.onePer !== undefined) {
            if (typeof fileDefinition.onePer !== 'string' || fileDefinition.onePer.trim() === '') {
                throw new Error(`files.${fileName}.onePer must be a non-empty string`);
            }

            getGroupDefinition(groupsDefinition, `files.${fileName}.onePer`, fileDefinition.onePer);
        }

        validateFileFieldDefinitions(fileName, fileDefinition, groupsDefinition);
    }
}

function normalizeFileDefinition(
    fileName: string,
    fileDefinition: unknown,
    defaultFormat = 'csv',
): OutputFileDefinition {
    if (!fileDefinition || typeof fileDefinition !== 'object' || Array.isArray(fileDefinition)) {
        throw new Error(`files.${fileName} must be an object`);
    }

    const definition = fileDefinition as OutputFileDefinition;

    if (Object.prototype.hasOwnProperty.call(definition, 'group') || Object.prototype.hasOwnProperty.call(definition, 'mode')) {
        throw new Error(`files.${fileName}.group and files.${fileName}.mode are no longer supported; use onePer for grouped output or omit it for one row per source row`);
    }

    const format = String(definition.format ?? defaultFormat).toLowerCase();

    if (format === 'txt') {
        if (definition.content === undefined) {
            throw new Error(`files.${fileName}.content is required for txt format`);
        }

        if (typeof definition.content !== 'string') {
            throw new Error(`files.${fileName}.content must be a string`);
        }

        return { format: 'txt', content: definition.content };
    }

    return {
        ...definition,
        format: 'csv',
    };
}

export function normalizeConfigDefinition(configDefinition: unknown): RowSplitterConfig {
    if (!configDefinition || typeof configDefinition !== 'object' || Array.isArray(configDefinition)) {
        return configDefinition as RowSplitterConfig;
    }

    const config = configDefinition as RowSplitterConfig;
    const legacyStructure = (configDefinition as Record<string, unknown>).structure;

    if (config.configVersion !== undefined && typeof config.configVersion !== 'string' && typeof config.configVersion !== 'number') {
        throw new Error('configVersion must be a string or number');
    }
    if (legacyStructure !== undefined) {
        throw new Error('structure is no longer supported; use sourceFile instead');
    }

    const normalizedSourceFile = normalizeSourceFileDefinition(config.sourceFile);
    const normalizedOutputFile = normalizeOutputFileSettings(config.outputFile);
    const normalizedFiles = normalizeFilesDefinition(config.files);

    if (!normalizedFiles) {
        throw new Error('Config file is missing required property: files');
    }

    validateFilesAgainstGroups(normalizedFiles, config.groups);

    return {
        configVersion: config.configVersion,
        sourceFile: normalizedSourceFile,
        outputFile: normalizedOutputFile,
        files: normalizedFiles,
        groups: config.groups,
    };
}
