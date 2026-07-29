variable "compartment_id" {
  description = "OCID from your compartment page"
  type        = string
}

variable "tenancy_ocid" {
  description = "OCID from your tenancy page"
  type        = string
}

variable "region" {
  description = "region where you have OCI tenancy"
  type        = string
  default     = "us-sanjose-1"
}

variable "logging_group_id" {
  description = "OCID of logging group to include log in"
  type        = string
}

variable "row_splitter_image_path" {
  description = "Path to the row-splitter function image in OCI registry"
  type        = string
}

variable "integration_trigger_image_path" {
  description = "Path to the integration-trigger function image in OCI registry"
  type        = string
}

variable "oic_trigger_url" {
  description = "Full OIC REST trigger URL"
  type        = string
}

variable "oic_idcs_base_url" {
  description = "IDCS base URL used to refresh OAuth tokens"
  type        = string
}

variable "oic_client_id" {
  description = "OAuth client ID for the OIC trusted application"
  type        = string
}

variable "oic_client_secret" {
  description = "OAuth client secret for the OIC trusted application"
  type        = string
  sensitive   = true
}

variable "oic_refresh_token" {
  description = "OAuth refresh token used by the function to obtain access tokens"
  type        = string
  sensitive   = true
}

variable "oic_scope" {
  description = "Optional OAuth scope for token refresh requests"
  type        = string
  default     = ""
}

variable "oic_tenant_name" {
  description = "Optional X-ID-TENANT-NAME header value"
  type        = string
  default     = ""
}

variable "oic_token_url" {
  description = "Optional explicit OAuth token URL. Leave empty to use OIC_IDCS_BASE_URL/oauth2/v1/token"
  type        = string
  default     = ""
}

variable "oic_access_token" {
  description = "Optional static access token for short-lived testing"
  type        = string
  default     = ""
  sensitive   = true
}

variable "oic_timeout_ms" {
  description = "HTTP timeout in milliseconds for OIC and token endpoint calls"
  type        = number
  default     = 15000
}
