# Row Splitter Function

## Configuration

### Overview

This function is triggered by an OCI Object Storage `Create Object` event.

For each input file, it:

1. Loads the matching config YAML from Object Storage.
2. Loads and parses the input file.
3. Applies the splitting rules from the configuration.
4. One or more files are created from this splitting and are zipped into a single file.
5. The zip file is uploaded back to an output location within output storage.
6. A `done.trg` file is created in the same location to establish that the original file has uploaded in its entirety.

### Supported Input Formats

- CSV (comma or pipe separated)
- XLS
- XLSX

### Object Naming Conventions

There are three object paths used by the row splitter: input, output and config. The structure of these paths is related and explained below.

#### Input File Path

Input files must be stored under a path beginning with `in/` and follow this structure: `in/{data-type}/filename.ext`

Example:

```text
in/supplier_invoice/test_data.csv
```

#### Config YAML Path

The input filepath determines which config file is loaded. Config files are stored under `config/` and must use the same `data-type` as the input: `config/{data-type}/config.yaml`.

Example input:

```text
in/supplier_invoice/test_data.csv
```

Expected config YAML:

```text
config/supplier_invoice/config.yaml
```

#### Output Path

The output path replaces `in/` with `out/` and appends a timestamp (epoch) to the input filename.

Example input:

```text
in/supplier_invoice/test_data.csv
```

Output objects:

```text
out/supplier_invoice/test_data_20260703150334.zip
out/supplier_invoice/done.trg
```

## Config YAML Structure

The YAML config file defines how source data maps to output columns and rows. See [examples/config.example.yaml](examples/config.example.yaml) for a complete example.

The config must contain:
- `files` — Defines the output structure

Optional top-level fields:
- `structure` — Describes the source file structure (header rows, column format)
- `groups` — Defines one-to-many relationships between output files

### Files

`files` defines the output structure. Each key under `files` is an output filename. Within each file, define output columns in the order they should appear:

```yaml
files:
  customers.csv:
    customer_name:
    customer_address:
    customer_country:
```

Columns can be configured with:

- No value specified — Column exists but is blank
- `value` — A constant value applied to all rows
- `from` — Source column name to map from the input file
- Other field sources (see [YAML Field Sources](#yaml-field-sources))

Example:

```yaml
files:
  customers.csv:
    customer_name:
      from: invoice_recipient_name
    customer_address:
      from: invoice_address
    customer_country:
      value: UK
  orders.csv:
    quantity:
      from: quantity
    description:
      from: item_description
    per_unit_cost:
      from: price
```

With this config, each row in the source file would be processed and two files would be created, each containing the same number of rows with the source data mapped into them. 

#### YAML Field Sources

Supported source options:

| Key    | Description |
| -------- | ------- |
| `value` | A constant string value that is used for all rows |
| `from` | Defines the column in the source file from which to take the value |
| `fromRoot` | Defines an item of metadata that should be used as the value. This can be `filename` for the source file full path, or `basename` for just the source filename |
| `fromGroup` | This key can be used if a group has been defined and is detailed [below](#grouping) |
| `sequence` | An integer with a start value which counts up with each row |
| `expr` | Allows an expression in order to perform some processing of values, like adding two values together. This is detailed [below](#expressions) |

If output files reference `fromGroup`, the config must also contain `groups`. This is detailed [below](#grouping).

### Grouping

Groups define one-to-many relationships within the source data. For example, if source rows contain customer data repeated for each order, grouping lets you extract unique customers once and associate multiple orders with each customer.

#### Defining a Group

Specify which source columns define a unique group using `groupBy`:

```yaml
groups:
  customer_order:
    groupBy:
      - invoice_recipient_name
      - invoice_address
```

Rows with identical values in these columns belong to the same group. Once defined, apply the group to output files:

```yaml
files:
  customers.csv:
    group: customer_order
    mode: group
    customer_name:
      from: invoice_recipient_name
    customer_address:
      from: invoice_address
    customer_country:
      value: UK

  orders.csv:
    group: customer_order
    mode: row
    quantity:
      from: quantity
    description:
      from: item_description
    per_unit_cost:
      from: price
```

This group demonstrates the `groupBy` key. This configures which columns in the source file which define a unique customer. Any source rows with the same `invoice_recipient_name` and `invoice_address` will define a new unique customer. Once this is defined, each output file can be configured to list only the grouped unique values, in this case `customers.csv`. And `orders.csv` can be configured to list all rows, with each associated with a customer row:

```yaml
groups:
  customer_order:
    groupBy:
      - invoice_recipient_name
      - invoice_address
    key:
      prefix: CUST
      start: 100000
    count:
      prefix: ''
      start: 1
```

The `key` generates a unique identifier for each group (e.g., `CUST100000`, `CUST100001`). The `count` starts fresh for each group, counting from the specified start value.

These generators are referenced using `fromGroup`:

```yaml
files:
  customers.csv:
    group: customer_order
    mode: group
    
    customer_id:
      fromGroup: customer_order.key
    customer_name:
      from: invoice_recipient_name
    customer_address:
      from: invoice_address
    customer_country:
      value: UK

  orders.csv:
    group: customer_order
    mode: row
    
    customer_id:
      fromGroup: customer_order.key
    line_number:
      fromGroup: customer_order.count
    quantity:
      from: quantity
    description:
      from: item_description
    per_unit_cost:
      from: price
```

So the `customer_id` column is shared by both files and links orders to customers.

### Structure Options

The optional `structure` block controls how worksheet columns are mapped for CSV and XLSX input files.

```yaml
structure:
  headerRowPresent: true
  ignoreHeaderRow: true
```

Behavior:

- `headerRowPresent: true` and `ignoreHeaderRow: true`: skip the first row and use `C1`, `C2`, `C3`, and so on.
- `headerRowPresent: true` and `ignoreHeaderRow: false` or omitted: skip the first row and use the first row values as property names.
- `headerRowPresent: false`: treat the first row as data and use `C1`, `C2`, `C3`, and so on.
- If `structure` is omitted, both values are treated as `false`.

### Advanced Formatting

#### Expressions

Expressions allow you to perform calculations and transformations on field values. Use the `expr` key to define an expression that operates on source columns:

```yaml
files:
  transactions.csv:
    gross_amount:
      from: amount
    tax_amount:
      from: tax
    net_amount:
      expr: number(amount) - number(tax)
    total_items:
      expr: number(quantity_a) + number(quantity_b) + number(quantity_c)
```

Expressions support:

- `number(columnName)` — Convert a column value to a number for arithmetic
- Arithmetic operators: `+`, `-`, `*`, `/`
- Parentheses for grouping: `(number(a) + number(b)) * number(c)`
- String concatenation: `columnName & " suffix"`

Example with formatting:

```yaml
files:
  output.csv:
    line_total:
      expr: number(unit_price) * number(quantity)
      format: currency
```

#### Lookup Mapping

`lookup` lets you map a source value to a different output value. It works alongside `from`.

Example:

```yaml
files:
  output.csv:
    file_type:
      from: extension
      lookup:
        txt: text
        csv: comma-separated-value
        default: unknown
```

In this example, if the value of the column 'extension' in the source file is 'csv', then the lookup will put the corresponding lookup value (comma-separated-value) is placed in the 'file_type' column in the output file.

Behavior:

- The source value is resolved first (`from`, `expr`, `fromGroup`, etc.).
- If that value exists as a key in `lookup`, the mapped value is used.
- If there is no key match and `default` exists, `default` is used.
- If there is no key match and no `default`, the original value is kept.

#### Date Transform

The `ddmmyyyy_to_yyyymmdd` transform accepts both padded and abbreviated dates.

Examples:

- `09/02/2026` -> `2026/02/09`
- `9/2/26` -> `2026/02/09`
- `2/1/26` -> `2026/01/02`

#### Text Files

You can create static text files in the output. Use `format: txt` and provide the content as a literal string:

```yaml
files:
  Metadata.txt:
    format: txt
    content: |
      Export Date : 2026-07-23
      Source System : Oracle
```

Text files are useful for creating metadata files, manifests, or other documentation that should accompany the data. The `content` field supports multi-line strings using the YAML pipe operator (`|`).

## Deployment

The Row Splitter is deployed as a containerized OCI Function. To build and push the image:

```shell
docker build --platform=linux/amd64 -f apps/row-splitter/Dockerfile -t lhr.ocir.io/[repositoryNamespace]/row-splitter apps/row-splitter
docker push lhr.ocir.io/[repositoryNamespace]/row-splitter
```

Refer to the [main repository README](../../README.md) for full deployment and infrastructure setup instructions.

## Developer Instructions

### Event Payload Requirements

The function expects these Object Storage event fields:

- `data.resourceName`
- `data.additionalDetails.bucketName`
- `data.additionalDetails.namespace`

### To run the RowSplitter function locally

Configure `localtest.js` as follows:

- `resourceName` (local source file)
- `additionalDetails.bucketName` (local folder)
- `additionalDetails.namespace: 'localtest'` (already done)

Then run: `node localtest.js`