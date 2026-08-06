import type { TabularFile, TabularRow } from '../types.js';

export interface GroupSequenceConfig {
    prefix: string;
    start: number;
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

interface GroupDefinition {
    groupBy: string[];
    key?: Record<string, unknown>;
    count?: Record<string, unknown>;
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
    config: Record<string, unknown>,
    configName: string,
): GroupSequenceConfig {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`${configName} must be an object`);
    }
    const sequence = (
        Object.prototype.hasOwnProperty.call(config, 'sequence') ? config.sequence : config
    ) as Record<string, unknown>;
    if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) {
        throw new Error(`${configName} must be a sequence-like object`);
    }
    const prefix = String(sequence.prefix ?? '');
    const start = Number(sequence.start ?? 1);
    if (!Number.isInteger(start) || start < 0) {
        throw new Error(`${configName}.start must be a non-negative integer`);
    }
    return { prefix, start };
}

function assignGroupMetadata(groupState: GroupState): void {
    for (const [groupIndex, group] of groupState.groups.entries()) {
        group.groupIndex = groupIndex;
        group.groupKey = groupState.keyConfig
            ? `${groupState.keyConfig.prefix}${groupState.keyConfig.start + groupIndex}`
            : undefined;
        group.rowCounts = groupState.countConfig
            ? group.rows.map((_, rowIndex) =>
                `${groupState.countConfig!.prefix}${groupState.countConfig!.start + rowIndex}`)
            : [];
        for (const [rowIndex, row] of group.rows.entries()) {
            groupState.rowToGroup.set(row, { group, rowIndex });
        }
    }
}

export function buildGroupDefinitions(
    rows: TabularRow[],
    groupsConfig: Record<string, unknown>,
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
            ? normalizeGroupSequenceConfig(groupDefinition.key, `groups.${groupName}.key`)
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
