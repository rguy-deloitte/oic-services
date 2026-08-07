# OIC Services

## Table of Contents

- [Purpose](#purpose)
- [Architecture](#architecture)
- [Repository Structure](#repository-structure)
- [Prerequisites](#prerequisites)
- [Deployment](#deployment)
- [Development](#development)
- [References](#references)

## Purpose

OIC Helper functions for data transformation and integration:

- [Row Splitter](./apps/row-splitter/README.md) - Splits input data into the header/detail format required by ESS upload jobs

## Architecture

![Architecture Diagram](./oics-architecture-diagram.png)

| Resource      | Purpose |
| ------------- |:-------------:|
| [Container Registry & Repository](https://docs.oracle.com/en-us/iaas/Content/Registry/Concepts/registryoverview.htm) | Stores container images for OCI Functions |
| [VCN & Subnet](https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/overview.htm) | Provides secure hosting for OCI Function services |
| [Service Gateway](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/servicegateway.htm) | Enables services to access OCI resources (e.g., Container Registry) |
| [OCI Function](https://docs.oracle.com/en-us/iaas/Content/Functions/Concepts/functionsoverview.htm) | Serverless compute for running transformation functions |
| [Service Log](https://docs.oracle.com/en-us/iaas/Content/Logging/Concepts/loggingoverview.htm) | Centralized logging for function invocations and events |

## Repository Structure

This repository is organized as a monorepo to support multiple applications:

```
oic-services/
├── apps/
│   ├── row-splitter/           # Individual application with its own Dockerfile and config
│   │   ├── Dockerfile
│   │   ├── func.ts
│   │   ├── func.yaml
│   │   ├── README.md           # App-specific documentation
│   │   ├── localtest.ts
│   │   ├── package.json
│      ├── src/
│   │   └── examples/
│   └── <new-app>/              # Pattern for future applications
├── oci-object-storage/         # Object storage configuration and test data
│   ├── row-splitter/           # App-specific files
│   │   ├── source/             # Input test data for row-splitter
│   │   └── config/             # Files defining the formatting for row-splitter
├── docker-bake.hcl             # Multi-app Docker build configuration
├── main.tf, variables.tf       # Terraform infrastructure as code
├── terraform.tfvars            # Terraform variables (configure locally)
├── Makefile                    # Build and deployment tasks
└── README.md                   # This file
```

- Each app under `apps/` contains its own Dockerfile and runtime configuration
- Terraform at the repository root manages shared infrastructure
- Reusable code should be placed under `packages/` once shared across multiple applications

## Prerequisites

Before deploying, ensure you have:

- Docker and Docker Buildx installed
- OCI CLI configured with appropriate credentials
- Terraform installed
- Access to an OCI Container Registry
- An OCI compartment for deployment

### Configure Environmental Variables

Create a `terraform.tfvars` file in the repository root with your OCI details:

```hcl
compartment_id   = "<your_compartment_OCID_here>"
region           = "uk-london-1"
tenancy_ocid     = "<your_tenancy_id_here>"
logging_group_id = "<your_logging_group_id_here>"
image_path       = "<docker_image_path>"  # Set after building and pushing images
```

Create a `.env` file in the repository root with the OCI repository namespace:

```
REPOSITORY_NAMESPACE="<your_repository_namespace_here>"
```

## Deployment

### Authentication

Set up OCI CLI authentication sessions before deployment:

```bash
oci session authenticate --profile DEFAULT
oci session authenticate --profile OCITF
```

Login to Docker:

```bash
docker login lhr.ocir.io
```

### Build and Push Docker Images

#### Build All Applications

To build all applications at once, you can use ```npm``` commands. These will load the repository namespace variable from ```.env``` and run the Docker buildx commands:

```bash
npm run build:all
```

To also push all the images, you can use ```deploy:all```:

```bash
npm run deploy:all
```

**Note**: Images within the Image Registry may need to be moved to the correct compartment if this is your first push to the registry.

#### Build Individual Application

To build and optionally push a single application (e.g., Row Splitter):

```bash
npm run build:row-splitter     # Build only
npm run deploy:row-splitter    # Build and push
```
**Note**: Images within the Image Registry may need to be moved to the correct compartment if this is your first push to the registry.

### Deploy Infrastructure

Once Docker images are built and pushed set the image paths within `terraform.tfvars`.

```hcl
row_splitter_image_path = "lhr.ocir.io/[repositoryNamespace]/row-splitter"
```

Then you can deploy the infrastructure:

```bash
terraform init
terraform plan
terraform apply
```

### Application-Specific Deployment

Each application has its own deployment instructions and configuration. See the individual application README files for details:

- [Row Splitter Deployment](./apps/row-splitter/README.md#deployment)

## Logging

Function logs are centralized in OCI Logging and are available for all deployed applications.

### Viewing Logs

1. Open the OCI Console
2. Navigate to **Developer Services → Functions → Applications**
3. Select the application containing your function
4. Open the **Monitoring** tab
5. Click on the function invocation log to view detailed logs

Logs include:
- Function invocation details
- Input parameters and outputs
- Execution duration
- Error information and stack traces

This centralized logging applies to all functions deployed in the repository, including the Row Splitter and any future applications.

## Development

### Local Testing

Most applications include local testing capabilities. Refer to the individual app README for instructions:

- [Row Splitter Local Testing](./apps/row-splitter/README.md#developer-instructions)

### Repository Details

- **Compartment**: First-time image pushes may require moving the image to the correct compartment
- **OCI Functions**: Use `fn invoke [application-name] [function-name]` to manually test deployed functions
- **OCI Logs**: Application logs are available in OCI Logging console under `Developer Services -> Functions -> Applications`

## References

### Terraform & Infrastructure

- [OCI Terraform Provider Documentation](https://registry.terraform.io/providers/oracle/oci/latest/docs)
- [Terraform OCI Get Started](https://developer.hashicorp.com/terraform/tutorials/oci-get-started)
- [OCI Terraform Concepts](https://docs.oracle.com/en-us/iaas/Content/dev/terraform/home.htm)
- [OCI IaC Deployment Architectures](https://docs.oracle.com/en/cloud/foundation/iac/index.html#deployment-architectures)

### OCI CLI, Functions & Docker

- [OCI Functions Overview](https://docs.oracle.com/en-us/iaas/Content/Functions/home.htm)
- [OCI Terraform Functions Tutorial](https://developer.hashicorp.com/terraform/tutorials/oci-get-started/oci-build)
- [Fn Project Node.js Tutorial](https://fnproject.io/tutorials/node/intro/)
- [Docker Documentation](https://docs.docker.com/get-started/)

### Useful Commands

```bash
# List OCI compartments
oci iam compartment list --config-file ~/.oci/config --profile DEFAULT --auth security_token --compartment-id-in-subtree true

# Refresh OCI authentication token
oci session refresh --profile OCITF

# Manually invoke a function
fn invoke [application-name] [function-name]
```
