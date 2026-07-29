# Integration Trigger Function

OCI Function that receives Object Storage create events and triggers an Oracle Integration Cloud (OIC) REST integration.

## What it does

1. Validates the Object Storage event payload.
2. Extracts file path parts from `data.resourceName`.
3. Builds the JSON payload expected by your OIC integration.
4. Obtains an OAuth access token from Oracle Identity Cloud Service (IDCS) using a refresh token.
5. Sends a POST request to the OIC REST trigger endpoint.

## Required environment variables

Set these on the deployed OCI Function:

- `OIC_TRIGGER_URL`: Full OIC REST trigger endpoint URL.
- `OIC_CLIENT_ID`: Trusted application client ID from IDCS.
- `OIC_CLIENT_SECRET`: Trusted application client secret from IDCS.
- `OIC_REFRESH_TOKEN`: OAuth refresh token for the trusted app.
- `OIC_IDCS_BASE_URL`: IDCS base URL (for example `https://idcs-xxxx.identity.oraclecloud.com`).

Optional:

- `OIC_TOKEN_URL`: Full token URL. If set, this is used instead of `OIC_IDCS_BASE_URL + /oauth2/v1/token`.
- `OIC_SCOPE`: Optional scope included in token refresh requests.
- `OIC_TENANT_NAME`: Optional `X-ID-TENANT-NAME` request header.
- `OIC_TIMEOUT_MS`: HTTP timeout in milliseconds. Default `15000`.
- `OIC_JOB_NAME`: Included in the payload as `jobName`. Default `test`.
- `OIC_ACCESS_TOKEN`: Static access token override for short-lived testing only.

## Build and deploy image

From repo root:

```bash
npm run build:integration-trigger
npm run deploy:integration-trigger
```