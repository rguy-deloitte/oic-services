variable "REPOSITORY_NAMESPACE" {
}

group "default" {
  targets = ["row-splitter"]
}

target "row-splitter" {
  context = "apps/row-splitter"
  platforms = ["linux/amd64"]
  tags = ["lhr.ocir.io/${REPOSITORY_NAMESPACE}/row-splitter:latest"]
}

target "integration-trigger" {
  context = "apps/integration-trigger"
  platforms = ["linux/amd64"]
  tags = ["lhr.ocir.io/${REPOSITORY_NAMESPACE}/integration-trigger:latest"]
}
