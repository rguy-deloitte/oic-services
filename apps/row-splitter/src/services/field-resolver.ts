import type { FieldDefinition, FieldDefinitionObject, LookupMap, SequenceDefinition } from '../types.js';
import type { SplitContext } from './grouping.js';

const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const { Jexl } = require('jexl');

dayjs.extend(customParseFormat);

function parseNumericValue(value: unknown): number {
    if (value === '' || value === null || value === undefined) return 0;
    if (typeof value === 'number') return value;
    const trimmedValue = String(value).trim();
    if (trimmedValue === '') return 0;
    const normalizedValue = trimmedValue.replace(/\s+/g, '');
    const hasComma = normalizedValue.includes(',');
    const hasDot = normalizedValue.includes('.');

    if (hasComma && hasDot) {
        const lastCommaIndex = normalizedValue.lastIndexOf(',');
        const lastDotIndex = normalizedValue.lastIndexOf('.');
        if (lastCommaIndex > lastDotIndex) {
            return Number(normalizedValue.replace(/\./g, '').replace(',', '.'));
        }
        return Number(normalizedValue.replace(/,/g, ''));
    }
    if (hasComma) {
        const commaParts = normalizedValue.split(',');
        if (commaParts.length === 2 && commaParts[1].length <= 2) {
            return Number(normalizedValue.replace(',', '.'));
        }
        return Number(normalizedValue.replace(/,/g, ''));
    }
    return Number(normalizedValue);
}

function createExpressionEngine() {
    const engine = new Jexl();
    engine.addFunction('number', (value: unknown) => parseNumericValue(value));
    engine.addFunction('round', (value: unknown, precision = 0) => {
        const factor = 10 ** precision;
        return Math.round((parseNumericValue(value) + Number.EPSILON) * factor) / factor;
    });
    return engine;
}

const jexl = createExpressionEngine();

function buildExpressionContext(context: SplitContext): Record<string, unknown> {
    return {
        ...context.row,
        root: context.root,
        row: context.row,
        group: {
            key: context.groupContext.group.key,
            rows: context.groupContext.group.rows,
            index: context.groupContext.groupIndex,
            header: context.groupContext.header,
        },
        header: context.groupContext.header,
        lineNumber: context.lineIndex === null ? null : context.lineIndex + 1,
    };
}

function resolveGroupValue(fromGroupReference: string, context: SplitContext): string {
    const parts = String(fromGroupReference).split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`fromGroup must include an explicit group name: ${fromGroupReference}`);
    }

    const groupName = parts.shift();
    const keyName = parts.join('.');

    const groupState = context.groupContext.groupStates?.[groupName!];
    if (!groupState) {
        throw new Error(`fromGroup references unknown group: ${groupName}`);
    }

    const row = context.row || context.groupContext.group.rows[0];
    const rowGroupEntry = groupState.rowToGroup.get(row);
    if (!rowGroupEntry) throw new Error(`Row does not belong to group ${groupName}`);

    switch (keyName) {
        case 'key':
            if (!groupState.keyConfig) throw new Error(`groups.${groupName} has no key definition`);
            return rowGroupEntry.group.groupKey ?? '';
        case 'count':
            if (!groupState.countConfig) throw new Error(`groups.${groupName} has no count definition`);
            return rowGroupEntry.group.rowCounts?.[rowGroupEntry.rowIndex] ?? '';
        default:
            throw new Error(`fromGroup must end with .key or .count: ${fromGroupReference}`);
    }
}

function resolveSequenceValue(
    sequenceDefinition: string | SequenceDefinition,
    context: SplitContext,
): string {
    const sequence = typeof sequenceDefinition === 'string'
        ? { type: sequenceDefinition }
        : sequenceDefinition;
    switch (sequence.type) {
        case 'transaction': {
            const start = Number(sequence.start || 0);
            return `${sequence.prefix || ''}${start + context.groupContext.groupIndex}`;
        }
        case 'line':
            return String((context.lineIndex || 0) + 1);
        default:
            throw new Error(`Unsupported sequence type: ${sequence.type}`);
    }
}

function applyLookup(lookupDefinition: LookupMap, value: unknown): unknown {
    if (!lookupDefinition || typeof lookupDefinition !== 'object' || Array.isArray(lookupDefinition)) {
        throw new Error('lookup must be an object');
    }
    const lookupKey = value === null || value === undefined ? '' : String(value);
    if (Object.prototype.hasOwnProperty.call(lookupDefinition, lookupKey)) {
        return lookupDefinition[lookupKey];
    }
    if (Object.prototype.hasOwnProperty.call(lookupDefinition, 'default')) {
        return lookupDefinition.default;
    }
    return value;
}

function applyTransform(transformName: string, value: unknown): string {
    switch (transformName) {
        case 'ddmmyyyy_to_yyyymmdd': {
            if (!value) return '';
            const parsedDate = dayjs(String(value), [
                'DD/MM/YYYY', 'D/M/YYYY', 'DD/M/YYYY', 'D/MM/YYYY',
                'DD/MM/YY', 'D/M/YY', 'DD/M/YY', 'D/MM/YY',
            ], true);
            if (!parsedDate.isValid()) throw new Error(`Invalid date value: ${value}`);
            return parsedDate.format('YYYY/MM/DD');
        }
        case 'mmddyyyy_to_yyyymmdd': {
            if (!value) return '';
            const parsedDate = dayjs(String(value), [
                'MM/DD/YYYY', 'M/D/YYYY', 'MM/D/YYYY', 'M/DD/YYYY',
                'MM/DD/YY', 'M/D/YY', 'MM/D/YY', 'M/DD/YY',
            ], true);
            if (!parsedDate.isValid()) throw new Error(`Invalid date value: ${value}`);
            return parsedDate.format('YYYY/MM/DD');
        }
        default:
            throw new Error(`Unsupported transform: ${transformName}`);
    }
}

function applyFormat(formatName: string, value: unknown): string {
    switch (formatName) {
        case 'currency': {
            const numericValue = parseNumericValue(value);
            const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;
            if (roundedValue === 0) return '0';
            return roundedValue.toFixed(2);
        }
        default:
            throw new Error(`Unsupported format: ${formatName}`);
    }
}

function applyFieldModifiers(fieldDefinition: FieldDefinitionObject, value: unknown): unknown {
    let result = value;
    if (fieldDefinition.lookup) result = applyLookup(fieldDefinition.lookup, result);
    if (fieldDefinition.transform) result = applyTransform(fieldDefinition.transform, result);
    if (fieldDefinition.format) result = applyFormat(fieldDefinition.format, result);
    return result;
}

async function resolveSourceValue(
    fieldDefinition: FieldDefinitionObject,
    context: SplitContext,
): Promise<unknown> {
    if (Object.prototype.hasOwnProperty.call(fieldDefinition, 'value')) return fieldDefinition.value;
    if (fieldDefinition.from) return context.row?.[fieldDefinition.from] ?? '';
    if (fieldDefinition.fromRoot) return context.root?.[fieldDefinition.fromRoot] ?? '';
    if (fieldDefinition.fromGroup) return resolveGroupValue(fieldDefinition.fromGroup, context);
    if (fieldDefinition.sequence) return resolveSequenceValue(fieldDefinition.sequence, context);
    if (fieldDefinition.expr) return jexl.eval(fieldDefinition.expr, buildExpressionContext(context));
    return '';
}

export async function resolveFieldValue(
    fieldDefinition: FieldDefinition,
    context: SplitContext,
): Promise<string> {
    if (fieldDefinition === null || fieldDefinition === undefined) return '';
    if (typeof fieldDefinition !== 'object' || Array.isArray(fieldDefinition)) {
        return String(fieldDefinition);
    }
    const sourceValue = await resolveSourceValue(fieldDefinition, context);
    const finalValue = applyFieldModifiers(fieldDefinition, sourceValue);
    return String(finalValue);
}
