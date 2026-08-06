import type { OutputFileDefinition, StructureOptions } from '../types.js';

export interface RowSplitterConfig {
    structure?: StructureOptions;
    files?: Record<string, OutputFileDefinition>;
    groups?: Record<string, unknown>;
    primaryGroup?: string;
    [key: string]: unknown;
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

function normalizeFileDefinition(
    fileName: string,
    fileDefinition: unknown,
    defaultFormat = 'csv',
): OutputFileDefinition {
    if (!fileDefinition || typeof fileDefinition !== 'object' || Array.isArray(fileDefinition)) {
        throw new Error(`files.${fileName} must be an object`);
    }

    const definition = fileDefinition as OutputFileDefinition;
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

    return { ...config, files: normalizedFiles };
}
