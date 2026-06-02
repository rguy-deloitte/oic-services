terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "8.16.0"
    }
  }
}

provider "oci" {
  region              = var.region
  auth                = "SecurityToken"
  config_file_profile = "OCITF"
}

resource "oci_core_vcn" "oics_vcn" {
  # dns_label      = "oicservices"
  cidr_block     = "10.0.0.0/22"
  compartment_id = var.compartment_id
  display_name   = "oics-vcn"
}

resource "oci_core_subnet" "oics_private_subnet" {
  vcn_id                      = oci_core_vcn.oics_vcn.id
  cidr_block                  = "10.0.0.0/24"
  compartment_id              = var.compartment_id
  display_name                = "oics-private-subnet"
  prohibit_public_ip_on_vnic  = true
  # dns_label                   = "ftpbridgesubnet"
}

resource "oci_core_service_gateway" "oics_service_gateway" {
  display_name = "oics-bridge-servgate"
  compartment_id = var.compartment_id
  services {
      service_id = "ocid1.service.oc1.uk-london-1.aaaaaaaatwg7f5mnzoapfunl66n2qkp4ormiykqk3hiwksum63gcyjk7ysla"
  }
  vcn_id = oci_core_vcn.oics_vcn.id
}

resource "oci_core_default_route_table" "default-route-table" {
  compartment_id = var.compartment_id
  manage_default_resource_id = oci_core_vcn.oics_vcn.default_route_table_id

  route_rules {
    destination_type  = "SERVICE_CIDR_BLOCK"
    destination = "all-lhr-services-in-oracle-services-network"
    network_entity_id = oci_core_service_gateway.oics_service_gateway.id
  }
}

data "oci_objectstorage_namespace" "ns" {
  #Optional
  compartment_id = var.compartment_id
}

resource "oci_objectstorage_bucket" "test_bucket" {
    compartment_id = var.compartment_id
    name = "oics-object-storage"
    namespace = data.oci_objectstorage_namespace.ns.namespace

    #Optional
    access_type = "ObjectRead"  # Change to NoPublicAccess, but authentication must be set-up first
    object_events_enabled = "true" # https://docs.cloud.oracle.com/iaas/Content/Events/Concepts/eventsoverview.htm
    # retention_rules {
    #     display_name = var.retention_rule_display_name
    #     duration {
    #         #Required
    #         time_amount = var.retention_rule_duration_time_amount
    #         time_unit = var.retention_rule_duration_time_unit
    #     }
    #     time_rule_locked = var.retention_rule_time_rule_locked
    # }
    versioning = "Disabled"
}

# resource "oci_functions_application" "oics_fnapplication" {
#   compartment_id = var.compartment_id
#   display_name   = "oics-bridge-application"
#   subnet_ids     = [oci_core_subnet.oics_subnet.id]

#   image_policy_config {
#     is_policy_enabled = false
#   }
# }

# resource "oci_functions_function" "oics_function" {
#   application_id = oci_functions_application.oics_fnapplication.id
#   display_name   = "oics-bridge-function"
#   image          = var.image_path
#   memory_in_mbs  = 128

#   trace_config {
#     is_enabled = true
#   }
# }

# resource "oci_logging_log" "oics_log" {
#   display_name = "oic-services-log"
#   log_group_id = var.logging_group_id
#   log_type = "SERVICE"
#   is_enabled = "true"
#   retention_duration = "30"

#   configuration {
#     source {
#       category = "invoke"
#       resource = oci_functions_application.oics_fnapplication.id
#       service = "Functions"
#       source_type = "OCISERVICE"
#     }
#   }
# }