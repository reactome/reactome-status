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
COLLECTOR_ROLE="${COLLECTOR_ROLE:-EC2CloudwatchAgentRole}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SITE="$HERE/../site"
export AWS_DEFAULT_REGION=$REGION

cert_arn() {
  aws acm list-certificates --certificate-statuses ISSUED PENDING_VALIDATION \
    --query "CertificateSummaryList[?DomainName=='$DOMAIN'].CertificateArn | [0]" --output text
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
      --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides DomainName="$DOMAIN" CertificateArn="$arn" CollectorRoleName="$COLLECTOR_ROLE" \
      --tags Project=reactome-status
    "$0" outputs
    ;;
  site)
    # never touch data/ or raw/ (written by the collectors)
    aws s3 sync "$SITE/" "s3://$DOMAIN/" --delete \
      --exclude "data/*" --exclude "raw/*" --exclude "vendor/*" \
      --cache-control "max-age=300" --only-show-errors
    aws s3 sync "$SITE/vendor/" "s3://$DOMAIN/vendor/" \
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
