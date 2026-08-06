import type { StructureOptions } from './tabular-parser.js';
import type { FieldDefinition, FieldDefinitionObject } from './field-resolver.js';

export interface GroupSequenceInput {
    sequence?: {
        prefix?: string;
        start?: number;
    };
    prefix?: string;
    start?: number;
}

export interface GroupDefinition {
    groupBy: string[];
    key?: GroupSequenceInput;
    count?: GroupSequenceInput;
}

export interface OutputFileDefinition {
    format?: 'csv' | 'txt';
    onePer?: string;
    includeHeader?: boolean;
    content?: string;
    [key: string]: FieldDefinition | string | boolean | undefined;
}

export interface RowSplitterConfig {
    structure?: StructureOptions;
    files?: Record<string, OutputFileDefinition>;
    groups?: Record<string, GroupDefinition>;
}

function isFieldDefinitionObject(value: FieldDefinition | string | boolean | undefined): value is FieldDefinitionObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
    const normalizedFiles = normalizeFilesDefinition(config.files);

    if (!normalizedFiles) {
        throw new Error('Config file is missing required property: files');
    }

    validateFilesAgainstGroups(normalizedFiles, config.groups);

    return { ...config, files: normalizedFiles };
}
