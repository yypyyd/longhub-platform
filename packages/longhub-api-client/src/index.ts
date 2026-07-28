/**
 * 龙枢云台 API 客户端。
 * 正式版本由 contracts/openapi 生成；当前为占位骨架。
 */
export interface ApiError {
  code: string;
  message: string;
  request_id: string;
  retryable: boolean;
  details?: unknown;
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken(): Promise<string>;
}
