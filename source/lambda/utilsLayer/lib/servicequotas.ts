// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CloudWatchServiceException,
  MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  MetricInfo,
  paginateListServiceQuotas,
  paginateListServices,
  ServiceInfo,
  ServiceQuotasClient,
  ServiceQuotasServiceException,
} from "@aws-sdk/client-service-quotas";
import { CloudWatchHelper } from "./cloudwatch";
import { catchDecorator } from "./catch";
import { UnsupportedQuotaException } from "./error";
import { ServiceHelper, ServiceQuotaCustom, sleep } from "./exports";
import { logger } from "./logger";

/**
 * @description helper class for Service Quotas
 */
export class ServiceQuotasHelper extends ServiceHelper<ServiceQuotasClient> {
  readonly client;
  /**
   * @description module name to be used in logging
   */
  protected readonly moduleName: string;
  constructor() {
    super();
    this.client = new ServiceQuotasClient({
      customUserAgent: process.env.CUSTOM_SDK_USER_AGENT,
    });
    this.moduleName = <string>__filename.split("/").pop();
  }

  /**
   * @description method to get the ssm parameter
   * @param serviceCode - service code for which to generate quota list
   * @returns
   */
  @catchDecorator(ServiceQuotasServiceException, true)
  async getServiceCodes(): Promise<string[]> {
    logger.debug({
      label: this.moduleName,
      message: "getting services in Service quotas",
    });

    const services: ServiceInfo[] = [];
    const paginator = paginateListServices(
      {
        client: this.client,
        pageSize: 100,
      },
      {}
    );

    for await (const page of paginator) {
      services.push(...(page.Services as ServiceInfo[]));
    }
    return services
      .map((value) => value.ServiceCode)
      .filter((value) => value !== undefined)
      .map((value) => <string>value);
  }

  /**
   * @description returns a list of services supported by the Servrice Quotas
   * @returns
   */
  @catchDecorator(ServiceQuotasServiceException, true)
  async getQuotaList(serviceCode: string) {
    logger.debug({
      label: this.moduleName,
      message: `getting quota list for ${serviceCode}`,
    });

    const paginator = paginateListServiceQuotas(
      {
        client: this.client,
        pageSize: 100,
      },
      { ServiceCode: serviceCode }
    );
    const quotasSupportingUsage: ServiceQuotaCustom[] = [];
    // get list of quotas which support usage metric
    for await (const page of paginator) {
      if (page.Quotas) {
        quotasSupportingUsage.push(
          ...page.Quotas.filter(
            (Quota) => Quota.UsageMetric?.MetricNamespace != ""
          )
        );
      }
      await sleep(1000);
    }

    logger.debug({
      label: this.moduleName,
      message: `quotas for ${serviceCode} supporting usage ${quotasSupportingUsage}`,
    });
    return quotasSupportingUsage;
  }

  /**
   * @description returns list of quotas that support utilization monitoring
   * @param quotas
   * @param serviceCode optional parameter needed only for logging
   */
  @catchDecorator(CloudWatchServiceException, true)
  async getQuotasWithUtilizationMetrics(
    quotas: ServiceQuotaCustom[],
    serviceCode?: string
  ) {
    logger.debug({
      label: this.moduleName,
      message: `getting quotas that support utilization metrics`,
    });
    if (quotas.length === 0) {
      logger.info({
        label: this.moduleName,
        message: `no quotas found for ${serviceCode}`,
      });
      return [];
    }

    const cw = new CloudWatchHelper();
    const validatedQuotas: ServiceQuotaCustom[] = [];
    await Promise.allSettled(
      quotas.map(async (quota) => {
        const queries = this.generateCWQuery(quota, 300);
        await cw.getMetricData(
          new Date(Date.now() - 15 * 60 * 1000), // fetch 15 minute data, validates if quota supports utilization monitoring
          new Date(),
          queries
        );
        validatedQuotas.push(quota);
      })
    );

    logger.debug({
      label: this.moduleName,
      message: `validated quotas: ${JSON.stringify(validatedQuotas)}`,
    });
    return validatedQuotas;
  }

  /**
   * @description method to make data query to fetch quota utilization
   * @param quota - quota for which cw query needs to be generated
   * @param period - period to apply metric statistic
   * @returns
   */
  @catchDecorator(UnsupportedQuotaException, true)
  generateCWQuery(quota: ServiceQuotaCustom, period: number) {
    logger.debug({
      label: this.moduleName,
      message: `generating cw query for quota ${quota.QuotaCode}`,
    });

    this.validateQuotaHasUsageMetrics(quota);
    const usageQuery = this.generateUsageQuery(
      <MetricInfo>quota.UsageMetric,
      period
    );
    const percentageUsageQuery = this.generatePercentageUtilizationQuery(
      <string>usageQuery.Id,
      quota.ValueCustom
    );
    logger.debug({
      label: this.moduleName,
      message: `${JSON.stringify({
        usageQuery: usageQuery,
        percentageUsageQuery: percentageUsageQuery,
      })}`,
    });
    console.log("Quota Definition: " + JSON.stringify(quota));
    console.log("Usage query: " + JSON.stringify(usageQuery));
    console.log(
      "Percentage Usage query: " + JSON.stringify(percentageUsageQuery)
    );
    return [usageQuery, percentageUsageQuery];
  }

  /**
   * @description validates if given quota supports usage metrics
   * @param quota
   */
  private validateQuotaHasUsageMetrics(quota: ServiceQuotaCustom) {
    if (
      !quota.UsageMetric ||
      !quota.UsageMetric.MetricNamespace ||
      !quota.UsageMetric.MetricName ||
      !quota.UsageMetric.MetricDimensions ||
      !quota.UsageMetric.MetricStatisticRecommendation
    )
      throw new UnsupportedQuotaException(
        `${quota.QuotaCode} for ${quota.ServiceName} does not currently support utilization monitoring`
      );
  }

  /**
   * generates a metric query id with a pattern, so that it can be used again
   * @param metricInfo
   */
  public generateMetricQueryId(metricInfo: MetricInfo): string {
    logger.debug({
      label: `generateMetricQueryId/metricInfo`,
      message: JSON.stringify(metricInfo),
    });
    let id =
      metricInfo.MetricNamespace?.toLowerCase().replace("/", "") +
      "_" +
      metricInfo.MetricName?.toLowerCase();

    if (metricInfo.MetricDimensions?.Service) {
      id =
        id +
        "_" +
        metricInfo.MetricDimensions?.Service.toLowerCase() +
        "_" +
        metricInfo.MetricDimensions?.Resource.toLowerCase() +
        "_" +
        metricInfo.MetricDimensions?.Class.toLowerCase().replace("/", "") +
        "_" +
        metricInfo.MetricDimensions?.Type.toLowerCase();
    }
    return id;
  }

  /**
   * @description get usage query to fetch quota usage
   * @param metricInfo
   * @param period - period to apply metric statistic
   * @returns
   */
  private generateUsageQuery(metricInfo: MetricInfo, period: number) {
    const usageQuery: MetricDataQuery = {
      Id: this.generateMetricQueryId(metricInfo),
      MetricStat: {
        Metric: {
          Namespace: metricInfo.MetricNamespace,
          MetricName: metricInfo.MetricName,
          Dimensions: Object.entries(
            metricInfo.MetricDimensions as Record<string, string>
          ).map(([key, value]) => {
            return { Name: key, Value: value };
          }),
        },
        Period: period,
        Stat: metricInfo.MetricStatisticRecommendation,
      },
      ReturnData: true,
    };
    return usageQuery;
  }

  /**
   * @description generates quota percentage utilization against current applied quota
   * @param usageQueryId cw query id that fetches usage metric
   * @returns
   */
  private generatePercentageUtilizationQuery(
    usageQueryId: string,
    quota: number | undefined
  ) {
    const expression = quota
      ? `(${usageQueryId}/${quota})*100`
      : `(${usageQueryId}/SERVICE_QUOTA(${usageQueryId}))*100`;
    const percentageUtilizationQuery: MetricDataQuery = {
      Id: `${usageQueryId}_pct_utilization`,
      Expression: expression,
      ReturnData: true,
    };
    return percentageUtilizationQuery;
  }
}
