# OIC Services

## Purpose

OIC Helper functions:
- Row Splitter - splits input data into the header/detail format required by ESS upload job

## Architecture

![Architecture Diagram](./oics-architecture-diagram.png)

Words...

| Resource      | Purpose |
| ------------- |:-------------:|
| [Container Registry & Repository](https://docs.oracle.com/en-us/iaas/Content/Registry/Concepts/registryoverview.htm) | Used to store the container image |
| [VCN & Subnet](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm) | Secure hosting of OIC Function Service |
| [Service Gateway](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/servicegateway.htm) | Allows ftp-bridge service access to required OCI services (eg. Container Registry) |
| [OCI Function](https://docs.oracle.com/en-us/iaas/Content/Functions/Concepts/functionsoverview.htm) | The ftp-bridge Service itself (serverless function) |
| [Service Log](https://docs.oracle.com/en-us/iaas/Content/Logging/Concepts/loggingoverview.htm) | Logging for the ftp-bridge service |

### Prepare the Repo

#### Create 'terraform.tfvars' file as follows

``` text
compartment_id      = "<your_compartment_OCID_here>"
region              = "uk-london-1"
tenancy_ocid        = "<your_tenancy_id_here>"
logging_group_id    = "<your_logging_group_id_here>"
image_path          = "<docker image path> (see below)"
```

### Deploy Docker Image

``` shell
docker login lhr.ocir.io
docker build --platform=linux/amd64 -t lhr.ocir.io/[repositoryNamespace]/row-splitter:0.1.0 .
docker push lhr.ocir.io/[repositoryNamespace]/row-splitter:0.1.0
```

(you may want to move the docker image to correct compartment if this is your first time pushing) <br>
Now update the `terraform.tfvars` file with the image path

### Deploy Infrastructure

``` shell
oci session authenticate (then choose 70, then type DEFAULT)
oci session authenticate (then choose 70, then type OCITF)
terraform apply
```

## Row Splitter Function

### Purpose

This function is triggered by an OCI Object Storage `Create Object` event.

For each input file, it:

1. Loads the matching config YAML from Object Storage.
2. Loads and parses the input file.
3. Applies the splitting rules.
4. Uploads `XlaTransactionUpload.zip` to the output prefix.
5. Uploads `done.trg` to the same output prefix.

### Supported Input Files

- `.csv`
- `.xls`
- `.xlsx`
- `.json`

### Object Naming Conventions

#### Input file path

Input files must be stored under a path beginning with `in/`.

Example:

```text
in/supplier_invoice/test_data.csv
```

#### Config YAML path

The config name is taken from the input file's parent directory.

Example input:

```text
in/supplier_invoice/test_data.csv
```

Expected config YAML:

```text
config/supplier_invoice/config.yaml
```

#### Output path

The output prefix is created by replacing `in/` with `out/` and removing the input filename.

Example input:

```text
in/supplier_invoice/test_data.csv
```

Output prefix:

```text
out/supplier_invoice/
```

Output objects:

```text
out/supplier_invoice/XlaTransactionUpload.zip
out/supplier_invoice/done.trg
```

## Config YAML Requirements

The config YAML must contain:

- `metadata`
- `groupBy`
- `header`
- `line`

Example metadata:

```yaml
metadata:
  name: LOCKTON_TR_ELW
  version: 3
```

### Output Layouts

See [examples/config.example.yaml](examples/config.example.yaml) for a complete example.

`header` and `line` must use section blocks.

Default `header` layout order:

- `TRANSACTION_NUMBER`
- `EVENT_TYPE_CODE`
- `LEDGER_NAME`
- `TRANSACTION_DATE`
- `Character1` to `Character50`
- `Number1` to `Number10`
- `Date1` to `Date10`
- `Long Character1` to `Long Character5`

Default `line` layout order:

- `TRANSACTION_NUMBER`
- `LINE_NUMBER`
- `Character1` to `Character100`
- `Number1` to `Number30`
- `Date1` to `Date10`
- `Long Character1` to `Long Character5`

Section blocks:

- `Characters`
- `Numbers`
- `Dates`
- `Long Characters`

Each named field in a section block replaces the next consecutive field of that type. Remaining fields are filled with empty generic names.

Example:

```yaml
header:
  TRANSACTION_NUMBER:
    sequence:
      type: transaction
      prefix: LCKTRELW
      start: 10000000001000
  EVENT_TYPE_CODE:
    value: JOURNAL_BALANCES
  LEDGER_NAME:
    value: TR ACTUALS USD Apr
  TRANSACTION_DATE:
    from: C6
    transform: ddmmyyyy_to_yyyymmdd
  Characters:
    EVENT_TYPE:
      value: LCKTRBALANCE
    REVERSAL_FLAG:
      value: N
  Long Characters:
    DETAIL:
      from: C9
```

The example above expands to `EVENT_TYPE`, `REVERSAL_FLAG`, `Character3` through `Character50`, `Number1` through `Number10`, `Date1` through `Date10`, and `DETAIL`, `Long Character2` through `Long Character5`.

Optional size overrides can be set inside a section block:

```yaml
line:
  TRANSACTION_NUMBER:
    fromGroup: TRANSACTION_NUMBER
  LINE_NUMBER:
    sequence:
      type: line
  Numbers:
    size: 12
    DEFAULT_AMOUNT:
      expr: number(C16) - number(C17)
      format: currency
```

All non-fixed fields in `header` and `line` must be declared inside `Characters`, `Numbers`, `Dates`, or `Long Characters`.

### Structure Options

The optional `structure` block controls how worksheet columns are mapped.

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

### YAML Field Sources

Supported source options:

- `value`
- `from`
- `fromRoot`
- `fromGroup`
- `sequence`
- `expr`

Examples:

```yaml
SOURCE_SYSTEM_FILE_NAME:
  fromRoot: filename

SOURCE_SYSTEM_BASENAME:
  fromRoot: basename

DETAIL:
  from: C9
```

Available root fields include:

- `filename`: full input object path
- `basename`: input filename only

### Date Transform

The `ddmmyyyy_to_yyyymmdd` transform accepts both padded and abbreviated dates.

Examples:

- `09/02/2026` -> `2026/02/09`
- `9/2/26` -> `2026/02/09`
- `2/1/26` -> `2026/01/02`

### Output Files

The function uploads:

- `XlaTransactionUpload.zip`
- `done.trg`

The zip contains:

- `XlaTrxH.csv`
- `XlaTrxL.csv`
- `Metadata_<metadata.name>.txt`

### Event Payload Requirements

The function expects these Object Storage event fields:

- `data.resourceName`
- `data.additionalDetails.bucketName`
- `data.additionalDetails.namespace`

### Logs

Function logs are available through OCI Logging.

To view them:

1. Open `Developer Services -> Functions -> Applications`.
2. Select the application.
3. Open the `Monitoring` tab.
4. Open the function invocation log.

### Test Flow

1. Build the docker image.
2. Push the docker image.
3. Apply the terrform.
4. Upload a config file to config/{filetype}/config.yaml
5. Upload an input file to in/{filetype}/ .
6. Confirm that the output prefix contains:
   - `XlaTransactionUpload.zip`
   - `done.trg`


## Notes & Links

- Terraform:
    - https://docs.oracle.com/en-us/iaas/Content/dev/terraform/home.htm
    - https://developer.hashicorp.com/terraform/tutorials/oci-get-started
    - https://docs.oracle.com/en-us/iaas/Content/dev/terraform/tutorials/tf-simple-infrastructure.htm
    - https://registry.terraform.io/providers/oracle/oci/latest/docs
    - https://docs.oracle.com/en/cloud/foundation/iac/index.html#deployment-architectures
- OCI CLI, Functions & Docker:
    - https://developer.hashicorp.com/terraform/tutorials/oci-get-started/oci-build
    - https://docs.oracle.com/en-us/iaas/Content/Functions/home.htm
    - https://fnproject.io/tutorials/node/intro/
    - https://docs.docker.com/get-started/
- To list compartments: `oci iam compartment list --config-file /Users/[your username]]/.oci/config --profile DEFAULT --auth security_token --compartment-id-in-subtree true`
- To refresh OCI auth token: `oci session refresh --profile OCITF`
- To manually invoke the function: `fn invoke ftp-bridge-application ftp-bridge-function`
