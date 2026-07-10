terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "8.22.0"
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
  display_name   = "oic-services-vcn"
}

resource "oci_core_subnet" "oics_private_subnet" {
  vcn_id                      = oci_core_vcn.oics_vcn.id
  cidr_block                  = "10.0.0.0/24"
  compartment_id              = var.compartment_id
  display_name                = "oic-services-private-subnet"
  prohibit_public_ip_on_vnic  = true
  # dns_label                   = "oic-services-subnet"
}

resource "oci_core_service_gateway" "oics_service_gateway" {
  display_name = "oic-services-servgate"
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

resource "oci_objectstorage_bucket" "row_splitter_bucket" {
  compartment_id = var.compartment_id
  name = "oic-services-object-storage"
  namespace = data.oci_objectstorage_namespace.ns.namespace

  #Optional
  access_type = "NoPublicAccess"
  object_events_enabled = "true" # https://docs.cloud.oracle.com/iaas/Content/Events/Concepts/eventsoverview.htm
  versioning = "Disabled"
}

resource "oci_functions_application" "oics_fnapplication" {
  compartment_id = var.compartment_id
  display_name   = "oic-services-application"
  subnet_ids     = [oci_core_subnet.oics_private_subnet.id]

  image_policy_config {
    is_policy_enabled = false
  }
}

resource "oci_functions_function" "oics_row_splitter_function" {
  application_id = oci_functions_application.oics_fnapplication.id
  display_name   = "row-splitter-function"
  image          = var.row_splitter_image_path
  memory_in_mbs  = 128

  trace_config {
    is_enabled = true
  }
}

resource "oci_logging_log" "oics_log" {
  display_name = "oic-services-log"
  log_group_id = var.logging_group_id
  log_type = "SERVICE"
  is_enabled = "true"
  retention_duration = "30"

  configuration {
    source {
      category = "invoke"
      resource = oci_functions_application.oics_fnapplication.id
      service = "Functions"
      source_type = "OCISERVICE"
    }
  }
}

resource "oci_events_rule" "oics_row_splitter_inbound_rule" {
  #Required
  actions {
    #Required
    action {
      #Required
      action_type = "FAAS"
      is_enabled = true
      function_id = oci_functions_function.oics_row_splitter_function.id
    }
  }
  compartment_id = var.compartment_id

  # condition = "{\"eventType\": \"com.oraclecloud.dbaas.autonomous.database.backup.end\", \"data\": {\"bucketId\": \"${oci_objectstorage_bucket.row_splitter_bucket.id}\"}}"

  condition_details {
    event_types = [
      "com.oraclecloud.objectstorage.createobject",
    ]
    data = jsonencode({
      "compartmentId": var.compartment_id,
      "resourceName": "in/*"
      "additionalDetails": {
        "bucketId": oci_objectstorage_bucket.row_splitter_bucket.bucket_id
      }
    })
  }
  display_name = "oic-services-row-splitter-inbound"
  is_enabled = true

  #Optional
  description = "Rule to send createObject events from the 'in' directory of the ${oci_objectstorage_bucket.row_splitter_bucket.name} to the ${oci_functions_function.oics_row_splitter_function.display_name} function"
}

resource "oci_identity_dynamic_group" "oics-functions-dynamic-group" {
  compartment_id = var.tenancy_ocid
  description = "Dynamic group for OIC Services functions"
  matching_rule = "ANY {resource.id='${oci_functions_function.oics_row_splitter_function.id}'}"
  name = "oic-services-functions-dynamic-group"
}

resource "oci_identity_policy" "oics-functions-policy" {
  compartment_id = var.compartment_id
  description = "Policy to allow OIC Services functions to manage objects in the ${oci_objectstorage_bucket.row_splitter_bucket.name} bucket"
  name = "oic-services-functions-policy"
  statements = ["allow dynamic-group ${oci_identity_dynamic_group.oics-functions-dynamic-group.name} to manage objects in compartment id ${var.compartment_id} where all {target.bucket.name='${oci_objectstorage_bucket.row_splitter_bucket.name}'}"]
}
