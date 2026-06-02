variable "compartment_id" {
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

variable "image_path" {
  description = "Path to the function image in OCI registry"
  type        = string
}

# variable "tenancy_ocid" {
#   description = "OCID from your tenancy page"
#   type        = string
# }
