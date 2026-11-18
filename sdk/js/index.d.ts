export interface FamAppClientOptions {
  workerUrl: string;
  apiKey?: string;
  defaultRetries?: number;
  defaultRetryDelayMs?: number;
}

export interface VerifyParams {
  utr: string;
  expectedAmount: number;
  orderId?: string | null;
  retries?: number;
  retryDelayMs?: number;
  markAsRead?: boolean;
  onPoll?: (attempt: number, totalRetries: number) => void;
}

export interface VerificationSuccessResponse {
  success: true;
  status: "VERIFIED";
  amount: number;
  sender: string;
  utr: string;
  txnId: string;
  orderId: string | null;
  raw: Record<string, any>;
}

export interface VerificationFailureResponse {
  success: false;
  status: "PENDING" | "ALREADY_CLAIMED" | "AMOUNT_MISMATCH" | "EXPIRED" | "UNAUTHORIZED" | "INVALID_UTR" | "NETWORK_ERROR" | string;
  message: string;
  attempts?: number;
  raw?: Record<string, any>;
}

export type VerificationResponse = VerificationSuccessResponse | VerificationFailureResponse;

export class FamAppClient {
  constructor(options: FamAppClientOptions);
  verify(params: VerifyParams): Promise<VerificationResponse>;
}

export default FamAppClient;
