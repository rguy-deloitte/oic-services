import type { FieldDefinition, GeneratedOutputFile, OutputFileDefinition, TabularFile, TabularRow } from '../types.js';
import type { RowSplitterConfig } from './configurations.js';
import type { GroupBridge, SplitContext } from './grouping.js';
import { buildDefaultGroupDefinitions, buildGroupDefinitions } from './grouping.js';
import { resolveFieldValue } from './field-resolver.js';

function getDefaultOutputMode(): 'row' {
    return 'row';
}

function createSplittingContext(
    root: TabularFile,
    row: TabularRow,
    groupContext: SplitContext['groupContext'],
    lineIndex: number | null,
): SplitContext {
    return { root, row, groupContext, lineIndex };
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

async function buildOutputRecords(
    fileName: string,
    sectionDefinition: OutputFileDefinition,
    groupBridge: GroupBridge,
    inputData: TabularFile,
): Promise<Record<string, string>[]> {
    if (!sectionDefinition) return [];
    if (typeof sectionDefinition !== 'object' || Array.isArray(sectionDefinition)) {
        throw new Error(`${fileName} must be an object`);
    }

    const groupName = sectionDefinition.group ?? groupBridge.primaryGroupName;
    const mode = sectionDefinition.mode ?? getDefaultOutputMode();
    const groupState = groupBridge.groupStates[groupName];

    if (!groupState) {
        const availableGroups = Object.keys(groupBridge.groupStates);
        throw new Error(
            availableGroups.length === 0
                ? `${fileName}: no groups defined and no fields specified`
                : `${fileName}.group must reference one of the configured groups: ${availableGroups.join(', ')}`,
        );
    }

    const fieldDefinitions = { ...sectionDefinition } as Record<string, FieldDefinition>;
    delete fieldDefinitions.group;
    delete fieldDefinitions.mode;
    delete fieldDefinitions.format;
    delete fieldDefinitions.includeHeader;

    const records: Record<string, string>[] = [];

    for (const [groupIndex, group] of groupState.groups.entries()) {
        const groupContext = {
            group,
            groupIndex,
            header: {},
            groupStates: groupBridge.groupStates,
            primaryGroupName: groupBridge.primaryGroupName,
        };

        if (mode === 'group') {
            const firstRow = group.rows[0] || {};
            records.push(await buildSplitObject(
                fieldDefinitions,
                createSplittingContext(inputData, firstRow, groupContext, null),
            ));
        } else if (mode === 'row') {
            for (const [lineIndex, row] of group.rows.entries()) {
                records.push(await buildSplitObject(
                    fieldDefinitions,
                    createSplittingContext(inputData, row, groupContext, lineIndex),
                ));
            }
        } else {
            throw new Error(`${fileName}.mode must be either 'group' or 'row'`);
        }
    }

    return records;
}

async function buildOutputFiles(
    filesDefinition: Record<string, OutputFileDefinition> | undefined,
    groupBridge: GroupBridge,
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
        const rows = await buildOutputRecords(fileName, fileDefinition, groupBridge, inputData);
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
    const rows = inputData.rows || [];
    const groupBridge = splitDefinition.groups
        ? buildGroupDefinitions(rows, splitDefinition)
        : buildDefaultGroupDefinitions(rows);

    return {
        files: await buildOutputFiles(splitDefinition.files, groupBridge, inputData),
    };
}
