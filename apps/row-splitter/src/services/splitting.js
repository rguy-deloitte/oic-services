const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
const { Jexl } = require('jexl');

dayjs.extend(customParseFormat);

function parseNumericValue(value) {
	if (value === '' || value === null || value === undefined) {
		return 0;
	}

	if (typeof value === 'number') {
		return value;
	}

	const trimmedValue = String(value).trim();

	if (trimmedValue === '') {
		return 0;
	}

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

// Create a shared Jexl expression engine with custom functions for use in splitting expressions
const jexl = createExpressionEngine();

function createExpressionEngine() {
	const engine = new Jexl();

	engine.addFunction('number', (value) => {
		return parseNumericValue(value);
	});

	engine.addFunction('round', (value, precision = 0) => {
		const factor = 10 ** precision;
		return Math.round((parseNumericValue(value) + Number.EPSILON) * factor) / factor;
	});

	return engine;
}

// Apply the provided splitting definition to the input data, producing output files.
async function applySplitting(inputData, splitDefinition) {
    const rows = inputData.rows || [];
    const groupBridge = splitDefinition.groups
        ? buildGroupDefinitions(rows, splitDefinition)
        : buildDefaultGroupDefinitions(rows);

    return {
        files: await buildOutputFiles(splitDefinition.files, groupBridge, inputData),
    };
}

async function buildOutputFiles(filesDefinition, groupBridge, inputData) {
    if (!filesDefinition) {
        return [];
    }

    if (typeof filesDefinition !== 'object' || Array.isArray(filesDefinition)) {
        throw new Error('files must be an object');
    }

    const outputFiles = [];

    for (const [fileName, fileDefinition] of Object.entries(filesDefinition)) {
        if (fileDefinition.format === 'txt') {
            outputFiles.push({
                name: fileName,
                format: 'txt',
                content: fileDefinition.content,
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

async function buildOutputRecords(fileName, sectionDefinition, groupBridge, inputData) {
    if (!sectionDefinition) {
        return [];
    }

    if (typeof sectionDefinition !== 'object' || Array.isArray(sectionDefinition)) {
        throw new Error(`${fileName} must be an object`);
    }

    const groupName = sectionDefinition.group ?? groupBridge.primaryGroupName;
    const mode = sectionDefinition.mode ?? getDefaultOutputMode(fileName);
    const groupState = groupBridge.groupStates[groupName];

    if (!groupState) {
        const availableGroups = Object.keys(groupBridge.groupStates);
        throw new Error(
            availableGroups.length === 0
                ? `${fileName}: no groups defined and no fields specified`
                : `${fileName}.group must reference one of the configured groups: ${availableGroups.join(', ')}`
        );
    }

    const fieldDefinitions = { ...sectionDefinition };
    delete fieldDefinitions.group;
    delete fieldDefinitions.mode;
    delete fieldDefinitions.format;
    delete fieldDefinitions.includeHeader;

    const records = [];

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
            const outputRecord = await buildSplitObject(
                fieldDefinitions,
                createSplittingContext(inputData, firstRow, groupContext, null)
            );

            records.push(outputRecord);
        } else if (mode === 'row') {
            for (const [lineIndex, row] of group.rows.entries()) {
                const outputRecord = await buildSplitObject(
                    fieldDefinitions,
                    createSplittingContext(inputData, row, groupContext, lineIndex)
                );

                records.push(outputRecord);
            }
        } else {
            throw new Error(`${fileName}.mode must be either 'group' or 'row'`);
        }
    }

    return records;
}

function getDefaultOutputMode() {
    return 'row';
}

function createSplittingContext(root, row, groupContext, lineIndex) {
	return {
		root,
		row,
		groupContext,
		lineIndex
	};
}

// Each output field is resolved in YAML order so the generated object keeps the same column order as the splitting definition.
async function buildSplitObject(fieldDefinitions, context) {
	const splitObject = {};

	for (const [fieldName, fieldDefinition] of Object.entries(fieldDefinitions)) {
		splitObject[fieldName] = await resolveFieldValue(fieldDefinition, {
			...context,
			currentOutput: splitObject
		});
	}

	return splitObject;
}

// Get source value and apply any transforms or formatting
async function resolveFieldValue(fieldDefinition, context) {
	if (fieldDefinition === null || fieldDefinition === undefined) {
		return '';
	}

	if (typeof fieldDefinition !== 'object' || Array.isArray(fieldDefinition)) {
		return String(fieldDefinition);
	}

	const sourceValue = await resolveSourceValue(fieldDefinition, context);
	const finalValue = applyFieldModifiers(fieldDefinition, sourceValue);

	return String(finalValue);
}

async function resolveSourceValue(fieldDefinition, context) {
	if (Object.prototype.hasOwnProperty.call(fieldDefinition, 'value')) {
		return fieldDefinition.value;
	}

	if (fieldDefinition.from) {
		return context.row?.[fieldDefinition.from] ?? '';
	}

	if (fieldDefinition.fromRoot) {
		return context.root?.[fieldDefinition.fromRoot] ?? '';
	}

	if (fieldDefinition.fromGroup) {
		return resolveGroupValue(fieldDefinition.fromGroup, context);
	}

	if (fieldDefinition.sequence) {
		return resolveSequenceValue(fieldDefinition.sequence, context);
	}

	if (fieldDefinition.expr) {
		return jexl.eval(fieldDefinition.expr, buildExpressionContext(context));
	}

	return '';
}

function applyFieldModifiers(fieldDefinition, value) {
	let result = value;

	if (fieldDefinition.lookup) {
		result = applyLookup(fieldDefinition.lookup, result);
	}

	if (fieldDefinition.transform) {
		result = applyTransform(fieldDefinition.transform, result);
	}

	if (fieldDefinition.format) {
		result = applyFormat(fieldDefinition.format, result);
	}

	return result;
}

// Maps input values to output values using a simple key/value object.
function applyLookup(lookupDefinition, value) {
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

function resolveSequenceValue(sequenceDefinition, context) {
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

function applyTransform(transformName, value) {
	switch (transformName) {
		case 'ddmmyyyy_to_yyyymmdd': {
			if (!value) {
				return '';
			}

			const parsedDate = dayjs(String(value), [
				'DD/MM/YYYY',
				'D/M/YYYY',
				'DD/M/YYYY',
				'D/MM/YYYY',
				'DD/MM/YY',
				'D/M/YY',
				'DD/M/YY',
				'D/MM/YY',
			], true);

			if (!parsedDate.isValid()) {
				throw new Error(`Invalid date value: ${value}`);
			}

			return parsedDate.format('YYYY/MM/DD');
		}

		case 'mmddyyyy_to_yyyymmdd': {
			if (!value) {
				return '';
			}

			const parsedDate = dayjs(String(value), [
				'MM/DD/YYYY',
				'M/D/YYYY',
				'MM/D/YYYY',
				'M/DD/YYYY',
				'MM/DD/YY',
				'M/D/YY',
				'MM/D/YY',
				'M/DD/YY',
			], true);

			if (!parsedDate.isValid()) {
				throw new Error(`Invalid date value: ${value}`);
			}

			return parsedDate.format('YYYY/MM/DD');
		}

		default:
			throw new Error(`Unsupported transform: ${transformName}`);
	}
}

function applyFormat(formatName, value) {
	switch (formatName) {
		case 'currency': {
			const numericValue = parseNumericValue(value);
			const roundedValue = Math.round((numericValue + Number.EPSILON) * 100) / 100;

			if (roundedValue === 0) {
				return '0';
			}

			return roundedValue.toFixed(2);
		}

		default:
			throw new Error(`Unsupported format: ${formatName}`);
	}
}

// Expressions can reference the current row directly, but they also get
// structured access to root data, the current group, and the generated header.
function buildExpressionContext(context) {
	return {
		...context.row,
		root: context.root,
		row: context.row,
		group: {
			key: context.groupContext.group.key,
			rows: context.groupContext.group.rows,
			index: context.groupContext.groupIndex,
			header: context.groupContext.header
		},
		header: context.groupContext.header,
		lineNumber: context.lineIndex === null ? null : context.lineIndex + 1
	};
}

function buildDefaultGroupDefinitions(rows) {
	const defaultGroupState = {
		name: 'default',
		groupBy: [],
		keyConfig: { prefix: '', start: 1 },
		countConfig: { prefix: '', start: 1 },
		groups: rows.length > 0 ? [{ key: 'default', rows }] : [],
		rowToGroup: new Map(),
	};

	assignGroupMetadata(defaultGroupState);

	return {
		groupStates: { default: defaultGroupState },
		primaryGroups: defaultGroupState.groups,
		primaryGroupName: 'default',
	};
}

function buildGroupDefinitions(rows, splitDefinition) {
	const groupsConfig = splitDefinition.groups;

	if (!groupsConfig) {
		throw new Error('groups must be defined');
	}

	if (typeof groupsConfig !== 'object' || Array.isArray(groupsConfig)) {
		throw new Error('groups must be an object');
	}

	const groupNames = Object.keys(groupsConfig);
	if (groupNames.length === 0) {
		throw new Error('groups must define at least one group');
	}

	const primaryGroupName = determinePrimaryGroupName(splitDefinition, groupNames);
	const groupStates = {};

	for (const groupName of groupNames) {
		const groupDefinition = groupsConfig[groupName];

		if (!groupDefinition || typeof groupDefinition !== 'object' || Array.isArray(groupDefinition)) {
			throw new Error(`groups.${groupName} must be an object`);
		}

		if (!Array.isArray(groupDefinition.groupBy)) {
			throw new Error(`groups.${groupName}.groupBy must be an array`);
		}

		const keyConfig = groupDefinition.key
			? normalizeGroupSequenceConfig(groupDefinition.key, `groups.${groupName}.key`)
			: null;
		const countConfig = groupDefinition.count
			? normalizeGroupSequenceConfig(groupDefinition.count, `groups.${groupName}.count`)
			: null;

		const groups = groupRows(rows, groupDefinition.groupBy);
		const groupState = {
			name: groupName,
			groupBy: groupDefinition.groupBy,
			keyConfig,
			countConfig,
			groups,
		};

		assignGroupMetadata(groupState);
		groupStates[groupName] = groupState;
	}

	return {
		groupStates,
		primaryGroups: groupStates[primaryGroupName].groups,
		primaryGroupName,
	};
}

function determinePrimaryGroupName(splitDefinition, groupNames) {
	if (splitDefinition.primaryGroup) {
		if (!groupNames.includes(splitDefinition.primaryGroup)) {
			throw new Error(`primaryGroup must reference one of the configured groups: ${groupNames.join(', ')}`);
		}

		return splitDefinition.primaryGroup;
	}

	if (groupNames.length === 1) {
		return groupNames[0];
	}

	throw new Error('primaryGroup is required when multiple groups are defined');
}

function assignGroupMetadata(groupState) {
	for (const [groupIndex, group] of groupState.groups.entries()) {
		group.groupIndex = groupIndex;
		group.groupKey = groupState.keyConfig
			? `${groupState.keyConfig.prefix}${groupState.keyConfig.start + groupIndex}`
			: undefined;
		group.rowCounts = groupState.countConfig
			? group.rows.map((_, rowIndex) => `${groupState.countConfig.prefix}${groupState.countConfig.start + rowIndex}`)
			: [];
		groupState.rowToGroup = groupState.rowToGroup || new Map();

		for (const [rowIndex, row] of group.rows.entries()) {
			groupState.rowToGroup.set(row, { group, rowIndex });
		}
	}
}

function normalizeGroupSequenceConfig(config, configName) {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		throw new Error(`${configName} must be an object`);
	}

	const sequence = config.sequence ?? config;
	if (!sequence || typeof sequence !== 'object' || Array.isArray(sequence)) {
		throw new Error(`${configName} must be a sequence-like object`);
	}

	const prefix = sequence.prefix ?? '';
	const start = Number(sequence.start ?? 1);

	if (!Number.isInteger(start) || start < 0) {
		throw new Error(`${configName}.start must be a non-negative integer`);
	}

	return { prefix, start };
}

function resolveGroupValue(fromGroupReference, context) {
	const parts = String(fromGroupReference).split('.');
	let groupName;
	let keyName;

	if (parts.length === 1) {
		keyName = parts[0];
		const groupNames = Object.keys(context.groupContext.groupStates || {});

		if (groupNames.length === 1) {
			groupName = groupNames[0];
		} else {
			return '';
		}
	} else {
		groupName = parts.shift();
		keyName = parts.join('.');
	}

	const groupState = context.groupContext.groupStates?.[groupName];
	if (!groupState) {
		return '';
	}

	const row = context.row || context.groupContext.group.rows[0];
	const rowGroupEntry = groupState.rowToGroup.get(row);

	if (!rowGroupEntry) {
		throw new Error(`Row does not belong to group ${groupName}`);
	}

	switch (keyName) {
		case 'key':
			if (!groupState.keyConfig) {
				throw new Error(`groups.${groupName} has no key definition`);
			}
			return rowGroupEntry.group.groupKey;
		case 'count':
			if (!groupState.countConfig) {
				throw new Error(`groups.${groupName} has no count definition`);
			}
			return rowGroupEntry.group.rowCounts[rowGroupEntry.rowIndex] ?? '';
		default:
			return '';
	}
}

// Grouping controls how many headers are produced. Rows in the same group share
// one header record and then emit one line record per source row.
function groupRows(rows, groupByFields) {
	const groups = new Map();

	for (const row of rows) {
		const groupKey = groupByFields.map((fieldName) => row[fieldName] || '').join('|');

		if (!groups.has(groupKey)) {
			groups.set(groupKey, {
				key: groupKey,
				rows: []
			});
		}

		groups.get(groupKey).rows.push(row);
	}

	return Array.from(groups.values());
}

module.exports = {
	applySplitting,
};
