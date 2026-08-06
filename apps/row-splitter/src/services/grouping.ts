import type { TabularFile, TabularRow } from './tabular-parser.js';
import type { GroupDefinition, GroupKeyDefinition, GroupKeyFormatInput, GroupSequenceInput } from './configurations.js';

export interface GroupSequenceConfig {
    prefix: string;
    start: number;
    paddingLength: number | null;
    format: string | null;
    epoch: string | null;
}

export interface GroupRecord {
    key: string;
    rows: TabularRow[];
    groupIndex?: number;
    groupKey?: string;
    rowCounts?: string[];
}

export interface GroupState {
    name: string;
    groupBy: string[];
    keyConfig: GroupSequenceConfig | null;
    countConfig: GroupSequenceConfig | null;
    groups: GroupRecord[];
    rowToGroup: Map<TabularRow, { group: GroupRecord; rowIndex: number }>;
}

export type GroupStates = Record<string, GroupState>;

export interface SplitContext {
    root: TabularFile;
    row: TabularRow;
    groupContext: {
        group: GroupRecord;
        groupIndex: number;
        header: Record<string, string>;
        groupStates: GroupStates;
    };
    lineIndex: number | null;
    currentOutput?: Record<string, string>;
}

function groupRows(rows: TabularRow[], groupByFields: string[]): GroupRecord[] {
    const groups = new Map<string, GroupRecord>();
    for (const row of rows) {
        const groupKey = groupByFields.map((fieldName) => row[fieldName] || '').join('|');
        if (!groups.has(groupKey)) {
            groups.set(groupKey, { key: groupKey, rows: [] });
        }
        groups.get(groupKey)!.rows.push(row);
    }
    return Array.from(groups.values());
}

function normalizeGroupSequenceConfig(
    config: GroupSequenceInput,
    configName: string,
): GroupSequenceConfig {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`${configName} must be an object`);
    }
    const sequence = (
        Object.prototype.hasOwnProperty.call(config, 'sequence') ? config.sequence : config
    );
    if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) {
        throw new Error(`${configName} must be a sequence-like object`);
    }
    const prefix = String(sequence.prefix ?? '');
    const { start, paddingLength } = normalizeSequenceStart(sequence.start ?? 1, `${configName}.start`);
    return { prefix, start, paddingLength, format: null, epoch: null };
}

function hasKeyFormat(config: GroupKeyDefinition): config is GroupKeyFormatInput {
    return Object.prototype.hasOwnProperty.call(config, 'format');
}

function normalizeGroupKeyConfig(
    config: GroupKeyDefinition,
    configName: string,
): GroupSequenceConfig {
    if (hasKeyFormat(config)) {
        if (typeof config.format !== 'string' || config.format.trim() === '') {
            throw new Error(`${configName}.format must be a non-empty string`);
        }
        if (!config.format.includes('{epoch}')) {
            throw new Error(`${configName}.format must include {epoch}`);
        }
        if (!config.format.includes('{sequence}')) {
            throw new Error(`${configName}.format must include {sequence}`);
        }

        const { start, paddingLength } = normalizeSequenceStart(config.sequenceStart ?? 1, `${configName}.sequenceStart`);
        return {
            prefix: '',
            start,
            paddingLength,
            format: config.format,
            epoch: String(Date.now()),
        };
    }

    return normalizeGroupSequenceConfig(config, configName);
}

function normalizeSequenceStart(
    startValue: number | string,
    propertyName: string,
): { start: number; paddingLength: number | null } {
    if (typeof startValue === 'number') {
        if (!Number.isInteger(startValue) || startValue < 0) {
            throw new Error(`${propertyName} must be a non-negative integer`);
        }
        return { start: startValue, paddingLength: null };
    }

    const trimmedValue = startValue.trim();
    if (!/^\d+$/.test(trimmedValue)) {
        throw new Error(`${propertyName} must be a non-negative integer`);
    }

    return {
        start: Number(trimmedValue),
        paddingLength: trimmedValue.length,
    };
}

function formatSequenceValue(config: GroupSequenceConfig, offset: number): string {
    const value = String(config.start + offset);
    const formattedValue = config.paddingLength === null
        ? value
        : value.padStart(config.paddingLength, '0');
    if (config.format) {
        return config.format
            .replaceAll('{epoch}', config.epoch ?? '')
            .replaceAll('{sequence}', formattedValue);
    }
    return `${config.prefix}${formattedValue}`;
}

function assignGroupMetadata(groupState: GroupState): void {
    for (const [groupIndex, group] of groupState.groups.entries()) {
        group.groupIndex = groupIndex;
        group.groupKey = groupState.keyConfig
            ? formatSequenceValue(groupState.keyConfig, groupIndex)
            : undefined;
        group.rowCounts = groupState.countConfig
            ? group.rows.map((_, rowIndex) =>
                formatSequenceValue(groupState.countConfig!, rowIndex))
            : [];
        for (const [rowIndex, row] of group.rows.entries()) {
            groupState.rowToGroup.set(row, { group, rowIndex });
        }
    }
}

export function buildGroupDefinitions(
    rows: TabularRow[],
    groupsConfig: Record<string, GroupDefinition>,
): GroupStates {
    if (!groupsConfig) throw new Error('groups must be defined');
    if (typeof groupsConfig !== 'object' || Array.isArray(groupsConfig)) {
        throw new Error('groups must be an object');
    }
    const groupNames = Object.keys(groupsConfig);
    if (groupNames.length === 0) throw new Error('groups must define at least one group');
    const groupStates: GroupStates = {};

    for (const groupName of groupNames) {
        const rawGroupDefinition = groupsConfig[groupName];
        if (!rawGroupDefinition || typeof rawGroupDefinition !== 'object' || Array.isArray(rawGroupDefinition)) {
            throw new Error(`groups.${groupName} must be an object`);
        }
        const groupDefinition = rawGroupDefinition as GroupDefinition;
        if (!Array.isArray(groupDefinition.groupBy)) {
            throw new Error(`groups.${groupName}.groupBy must be an array`);
        }
        const keyConfig = groupDefinition.key
            ? normalizeGroupKeyConfig(groupDefinition.key, `groups.${groupName}.key`)
            : null;
        const countConfig = groupDefinition.count
            ? normalizeGroupSequenceConfig(groupDefinition.count, `groups.${groupName}.count`)
            : null;
        const groupState: GroupState = {
            name: groupName,
            groupBy: groupDefinition.groupBy,
            keyConfig,
            countConfig,
            groups: groupRows(rows, groupDefinition.groupBy),
            rowToGroup: new Map(),
        };
        assignGroupMetadata(groupState);
        groupStates[groupName] = groupState;
    }

    return groupStates;
}
