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

// Apply the provided splitting definition to the input data, producing header and line records for output.
async function applySplitting(inputData, splitDefinition) {
    // Group the incoming rows based on the groupBy keys specified in the split definition. 
    // The groupBy keys are used to determine which rows belong together in the same header file
	const groups = groupRows(inputData.rows || [], splitDefinition.groupBy || []);
	let headers = [];
	let lines = [];

	for (const [groupIndex, group] of groups.entries()) {
        // Build one header for each group
		const groupContext = {group, groupIndex, header: {}};
		const headerRecord = await buildHeaderRecord(inputData, splitDefinition, groupContext);

		headers.push(headerRecord);
		groupContext.header = headerRecord;

        // Then build one line for each row in the group
		const lineRecords = await buildLineRecords(inputData, splitDefinition, groupContext);
		lines.push(...lineRecords);
	}

	return {
		headers,
		lines
	};
}

async function buildHeaderRecord(inputData, splitDefinition, groupContext) {
	const firstRow = groupContext.group.rows[0] || {};

	return buildSplitObject(
		splitDefinition.header || {},
		createSplittingContext(inputData, firstRow, groupContext, null)
	);
}

async function buildLineRecords(inputData, splitDefinition, groupContext) {
	const lineRecords = [];

	for (const [lineIndex, row] of groupContext.group.rows.entries()) {
		const lineRecord = await buildSplitObject(
			splitDefinition.line || {},
			createSplittingContext(inputData, row, groupContext, lineIndex)
		);

		lineRecords.push(lineRecord);
	}

	return lineRecords;
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
		return context.groupContext.header?.[fieldDefinition.fromGroup] ?? '';
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

	if (fieldDefinition.transform) {
		result = applyTransform(fieldDefinition.transform, result);
	}

	if (fieldDefinition.format) {
		result = applyFormat(fieldDefinition.format, result);
	}

	return result;
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
