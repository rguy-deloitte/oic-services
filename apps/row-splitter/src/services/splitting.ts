import type { FieldDefinition, GeneratedOutputFile, OutputFileDefinition, TabularFile, TabularRow } from '../types.js';
import type { RowSplitterConfig } from './configurations.js';
import type { GroupRecord, GroupState, GroupStates, SplitContext } from './grouping.js';
import { buildGroupDefinitions } from './grouping.js';
import { resolveFieldValue } from './field-resolver.js';

function createSplittingContext(
    root: TabularFile,
    row: TabularRow,
    groupContext: SplitContext['groupContext'],
    lineIndex: number | null,
): SplitContext {
    return { root, row, groupContext, lineIndex };
}

function createGroupContext(group: GroupRecord, groupIndex: number, groupStates: GroupStates): SplitContext['groupContext'] {
    return {
        group,
        groupIndex,
        header: {},
        groupStates,
    };
}

function getGroupState(
    fileName: string,
    groupName: string,
    groupStates: GroupStates,
): GroupState {
    const groupState = groupStates[groupName];
    if (groupState) {
        return groupState;
    }

    const availableGroups = Object.keys(groupStates);
    throw new Error(
        availableGroups.length === 0
            ? `${fileName}: no groups defined and no fields specified`
            : `${fileName}.onePer must reference one of the configured groups: ${availableGroups.join(', ')}`,
    );
}

function getFieldDefinitions(fileDefinition: OutputFileDefinition): Record<string, FieldDefinition> {
    const fieldDefinitions = { ...fileDefinition } as Record<string, FieldDefinition>;
    delete fieldDefinitions.onePer;
    delete fieldDefinitions.format;
    delete fieldDefinitions.includeHeader;
    return fieldDefinitions;
}

async function buildSplitObject(
    fieldDefinitions: Record<string, FieldDefinition>,
    context: SplitContext,
): Promise<Record<string, string>> {
    const splitObject: Record<string, string> = {};
    for (const [fieldName, fieldDefinition] of Object.entries(fieldDefinitions)) {
        splitObject[fieldName] = await resolveFieldValue(fieldDefinition, {
            ...context,
            currentOutput: splitObject,
        });
    }
    return splitObject;
}

async function buildUngroupedOutputRecords(
    fieldDefinitions: Record<string, FieldDefinition>,
    groupStates: GroupStates,
    inputData: TabularFile,
): Promise<Record<string, string>[]> {
    const defaultGroup: GroupRecord = { key: 'default', rows: inputData.rows };
    const groupContext = createGroupContext(defaultGroup, 0, groupStates);
    const records: Record<string, string>[] = [];

    for (const [lineIndex, row] of inputData.rows.entries()) {
        records.push(await buildSplitObject(
            fieldDefinitions,
            createSplittingContext(inputData, row, groupContext, lineIndex),
        ));
    }

    return records;
}

async function buildGroupedOutputRecords(
    fileName: string,
    groupName: string,
    fieldDefinitions: Record<string, FieldDefinition>,
    groupStates: GroupStates,
    inputData: TabularFile,
): Promise<Record<string, string>[]> {
    const groupState = getGroupState(fileName, groupName, groupStates);
    const records: Record<string, string>[] = [];

    for (const [groupIndex, group] of groupState.groups.entries()) {
        const firstRow = group.rows[0] || {};
        records.push(await buildSplitObject(
            fieldDefinitions,
            createSplittingContext(inputData, firstRow, createGroupContext(group, groupIndex, groupStates), null),
        ));
    }

    return records;
}

async function buildOutputRecords(
    fileName: string,
    fileDefinition: OutputFileDefinition,
    groupStates: GroupStates,
    inputData: TabularFile,
): Promise<Record<string, string>[]> {
    if (!fileDefinition) return [];
    if (typeof fileDefinition !== 'object' || Array.isArray(fileDefinition)) {
        throw new Error(`${fileName} must be an object`);
    }

    const fieldDefinitions = getFieldDefinitions(fileDefinition);

    if (!fileDefinition.onePer) {
        return buildUngroupedOutputRecords(fieldDefinitions, groupStates, inputData);
    }

    return buildGroupedOutputRecords(fileName, fileDefinition.onePer, fieldDefinitions, groupStates, inputData);
}

async function buildOutputFiles(
    filesDefinition: Record<string, OutputFileDefinition> | undefined,
    groupStates: GroupStates,
    inputData: TabularFile,
): Promise<GeneratedOutputFile[]> {
    if (!filesDefinition) return [];
    if (typeof filesDefinition !== 'object' || Array.isArray(filesDefinition)) {
        throw new Error('files must be an object');
    }

    const outputFiles: GeneratedOutputFile[] = [];

    for (const [fileName, fileDefinition] of Object.entries(filesDefinition)) {
        if (fileDefinition.format === 'txt') {
            outputFiles.push({
                name: fileName,
                format: 'txt',
                content: String(fileDefinition.content ?? ''),
            });
            continue;
        }
        const rows = await buildOutputRecords(fileName, fileDefinition, groupStates, inputData);
        outputFiles.push({
            name: fileName,
            format: 'csv',
            includeHeader: fileDefinition.includeHeader !== false,
            rows,
        });
    }

    return outputFiles;
}

export async function applySplitting(
    inputData: TabularFile,
    splitDefinition: RowSplitterConfig,
): Promise<{ files: GeneratedOutputFile[] }> {
    const groupStates = splitDefinition.groups
        ? buildGroupDefinitions(inputData.rows || [], splitDefinition.groups)
        : {};

    return {
        files: await buildOutputFiles(splitDefinition.files, groupStates, inputData),
    };
}
