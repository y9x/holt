

export type VerificationResult = { ip: string; id: string }

export const verificationMap = new Map<string, (value: VerificationResult) => void>()

export const verifiedRoleNames: string[] = []
