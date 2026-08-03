variable "REPOSITORY_NAMESPACE" {
}

group "default" {
  targets = ["row-splitter", "camt-validator"]
}

target "row-splitter" {
  context = "apps/row-splitter"
  platforms = ["linux/amd64"]
  tags = ["lhr.ocir.io/${REPOSITORY_NAMESPACE}/row-splitter:latest"]
}

target "camt-validator" {
  context = "apps/camt-validator"
  platforms = ["linux/amd64"]
  tags = ["lhr.ocir.io/${REPOSITORY_NAMESPACE}/camt-validator:latest"]
}
