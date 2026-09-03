#!/usr/bin/env bash
# One-time infrastructure and site deployment for the Reactome status page.
#
#   infra/deploy.sh cert      request the ACM certificate and print the DNS validation record
#   infra/deploy.sh stack     create/update the CloudFormation stack (needs an ISSUED certificate)
#   infra/deploy.sh site      upload site/ to the bucket and invalidate CloudFront
#   infra/deploy.sh outputs   show stack outputs (CloudFront hostname for the Cloudflare CNAME)
#
# Requires AWS CLI credentials with rights on S3, CloudFront, ACM, IAM and CloudFormation.
set -euo pipefail

DOMAIN="${DOMAIN:-status.reactome.org}"
STACK="${STACK:-reactome-status-site}"
REGION=us-east-1            # CloudFront certificates must live in us-east-1
# COLLECTOR_ROLE may be set to "" to deploy without attaching the upload policy to any role
COLLECTOR_ROLE="${COLLECTOR_ROLE-EC2CloudwatchAgentRole}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$HERE/../site"
export AWS_REGION=$REGION AWS_DEFAULT_REGION=$REGION   # AWS_REGION takes precedence in CLI v2

cert_arn() {
  # prefer an ISSUED certificate; fall back to a pending one only so `cert` can print its record
  local arn
  arn=$(aws acm list-certificates --certificate-statuses ISSUED \
          --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
  if [[ "$arn" == "None" || -z "$arn" ]]; then
    arn=$(aws acm list-certificates --certificate-statuses PENDING_VALIDATION \
            --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text)
  fi
  echo "$arn"
}

case "${1:-}" in
  cert)
    arn=$(cert_arn)
    if [[ "$arn" == "None" || -z "$arn" ]]; then
      arn=$(aws acm request-certificate --domain-name "$DOMAIN" --validation-method DNS \
              --tags Key=Project,Value=reactome-status --query CertificateArn --output text)
      echo "requested $arn"; sleep 5
    fi
    echo "certificate: $arn"
    aws acm describe-certificate --certificate-arn "$arn" \
      --query "Certificate.{Status:Status,Record:DomainValidationOptions[0].ResourceRecord}" --output table
    echo "Add the CNAME above in Cloudflare (DNS only / grey cloud), then wait for Status = ISSUED."
    ;;
  stack)
    arn=$(cert_arn)
    status=$(aws acm describe-certificate --certificate-arn "$arn" --query Certificate.Status --output text)
    [[ "$status" == "ISSUED" ]] || { echo "certificate $arn is $status, not ISSUED"; exit 1; }
    aws cloudformation deploy --stack-name "$STACK" --template-file "$HERE/status-site.yaml" \
      --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
      --parameter-overrides DomainName="$DOMAIN" CertificateArn="$arn" CollectorRoleName="$COLLECTOR_ROLE" \
      --tags Project=reactome-status
    "$0" outputs
    ;;
  site)
    # never touch data/ or raw/ (written by the collectors)
    # the page lives under site/ (CloudFront OriginPath), a prefix the hosts' upload policy cannot write
    aws s3 sync "$SITE/" "s3://$DOMAIN/site/" --delete \
      --exclude "data/*" --exclude "vendor/*" \
      --cache-control "max-age=300" --only-show-errors
    # vendor files live under versioned directories (site/vendor/<lib>-<version>/), so immutable is safe
    aws s3 sync "$SITE/vendor/" "s3://$DOMAIN/site/vendor/" \
      --cache-control "max-age=31536000, immutable" --only-show-errors
    dist=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
    aws cloudfront create-invalidation --distribution-id "$dist" --paths "/*" --query Invalidation.Id --output text
    echo "site uploaded to s3://$DOMAIN and cache invalidated"
    ;;
  outputs)
    aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs" --output table
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
