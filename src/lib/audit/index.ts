/**
 * Enhanced Audit Logging
 *
 * Centralized audit logging for compliance with:
 * - Action tracking (who did what when)
 * - Sensitive data handling (personal data in evidence)
 * - Retention policies
 * - Export capabilities
 *
 * @see docs/ARCHITECTURE_V2.1.md
 */

import { prisma } from '@/lib/prisma';
import { headers } from 'next/headers';

/**
 * Audit action types
 */
export type AuditAction =
  // Search actions
  | 'search.executed'
  | 'search.cached'
  // Candidate actions
  | 'candidate.created'
  | 'candidate.updated'
  // Enrichment actions
  | 'enrichment.started'
  | 'enrichment.completed'
  | 'enrichment.failed'
  // Identity actions
  | 'identity.discovered'
  | 'identity.confirmed'
  | 'identity.rejected'
  | 'identity.email_revealed'
  // Personal data access
  | 'pii.accessed'
  | 'pii.stored'
  | 'pii.deleted';

/**
 * Resource types
 */
export type ResourceType =
  | 'search'
  | 'candidate'
  | 'identity_candidate'
  | 'confirmed_identity'
  | 'enrichment_session';

/**
 * Actor types
 */
export type ActorType = 'system' | 'recruiter' | 'subject' | 'admin';

/**
 * Audit entry input
 */
export interface AuditEntry {
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string;
  actorType: ActorType;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Sensitive data categories that require special handling
 */
const SENSITIVE_FIELDS = [
  'email',
  'phone',
  'address',
  'ssn',
  'password',
  'token',
  'secret',
];

/**
 * Personal data fields that should be noted but not redacted
 */
const PERSONAL_DATA_FIELDS = [
  'name',
  'authorName',
  'nameHint',
  'location',
  'company',
  'headline',
];

/**
 * Redact sensitive data from metadata
 * Replaces values with [REDACTED] but preserves keys for audit trail
 */
function redactSensitiveData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();

    // Check if this is a sensitive field
    if (SENSITIVE_FIELDS.some((field) => lowerKey.includes(field))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Recursively redact nested objects
      redacted[key] = redactSensitiveData(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      // Handle arrays
      redacted[key] = value.map((item) =>
        typeof item === 'object' && item !== null
          ? redactSensitiveData(item as Record<string, unknown>)
          : item
      );
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Check if metadata contains personal data
 */
function containsPersonalData(data: Record<string, unknown>): boolean {
  for (const key of Object.keys(data)) {
    const lowerKey = key.toLowerCase();
    if (PERSONAL_DATA_FIELDS.some((field) => lowerKey.includes(field))) {
      return true;
    }
    const value = data[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      if (containsPersonalData(value as Record<string, unknown>)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Get request context for audit logging
 */
async function getRequestContext(): Promise<{
  ipAddress?: string;
  userAgent?: string;
}> {
  try {
    const headersList = await headers();
    return {
      ipAddress:
        headersList.get('x-forwarded-for')?.split(',')[0].trim() ||
        headersList.get('x-real-ip') ||
        undefined,
      userAgent: headersList.get('user-agent') || undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Log an audit entry
 *
 * @param entry - Audit entry to log
 * @param options - Additional options
 */
export async function logAudit(
  entry: AuditEntry,
  options: {
    includeRequestContext?: boolean;
    redactSensitive?: boolean;
  } = {}
): Promise<string | null> {
  const { includeRequestContext = true, redactSensitive = true } = options;

  try {
    // Get request context if requested
    const requestContext = includeRequestContext
      ? await getRequestContext()
      : {};

    // Process metadata
    let processedMetadata = entry.metadata || {};

    // Redact sensitive data if requested
    if (redactSensitive && processedMetadata) {
      processedMetadata = redactSensitiveData(processedMetadata);
    }

    // Add personal data flag
    if (entry.metadata && containsPersonalData(entry.metadata)) {
      processedMetadata = {
        ...processedMetadata,
        _containsPersonalData: true,
      };
    }

    const auditLog = await prisma.auditLog.create({
      data: {
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        actorType: entry.actorType,
        actorId: entry.actorId,
        metadata: Object.keys(processedMetadata).length > 0
          ? JSON.parse(JSON.stringify(processedMetadata))
          : undefined,
        ipAddress: requestContext.ipAddress,
        userAgent: requestContext.userAgent,
      },
    });

    return auditLog.id;
  } catch (error) {
    console.error('[Audit] Failed to log entry:', error);
    return null;
  }
}

/**
 * Log search action
 */
export async function logSearch(
  queryHash: string,
  metadata: {
    query: string;
    resultCount: number;
    cached: boolean;
    provider: string;
  }
): Promise<void> {
  await logAudit({
    action: metadata.cached ? 'search.cached' : 'search.executed',
    resourceType: 'search',
    resourceId: queryHash,
    actorType: 'system',
    metadata,
  });
}

/**
 * Log enrichment action
 */
export async function logEnrichment(
  candidateId: string,
  sessionId: string,
  action: 'enrichment.started' | 'enrichment.completed' | 'enrichment.failed',
  metadata: Record<string, unknown>
): Promise<void> {
  await logAudit({
    action,
    resourceType: 'enrichment_session',
    resourceId: sessionId,
    actorType: 'system',
    metadata: {
      candidateId,
      ...metadata,
    },
  });
}

/**
 * Log identity action
 */
export async function logIdentityAction(
  action: 'identity.discovered' | 'identity.confirmed' | 'identity.rejected' | 'identity.email_revealed',
  identityCandidateId: string,
  candidateId: string,
  metadata: Record<string, unknown>
): Promise<void> {
  await logAudit({
    action,
    resourceType: 'identity_candidate',
    resourceId: identityCandidateId,
    actorType: 'recruiter', // TODO: Get from auth context
    metadata: {
      candidateId,
      ...metadata,
    },
  });
}

/**
 * Log PII access (for compliance)
 */
export async function logPiiAccess(
  resourceType: ResourceType,
  resourceId: string,
  accessType: 'accessed' | 'stored' | 'deleted',
  metadata: Record<string, unknown>
): Promise<void> {
  await logAudit({
    action: `pii.${accessType}` as AuditAction,
    resourceType,
    resourceId,
    actorType: 'recruiter', // TODO: Get from auth context
    metadata: {
      ...metadata,
      _piiAction: accessType,
    },
  });
}

/**
 * Query audit logs
 */
export async function queryAuditLogs(params: {
  resourceType?: ResourceType;
  resourceId?: string;
  action?: AuditAction;
  actorType?: ActorType;
  actorId?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<{
  logs: Array<{
    id: string;
    action: string;
    resourceType: string;
    resourceId: string;
    actorType: string;
    actorId: string | null;
    metadata: unknown;
    createdAt: Date;
  }>;
  total: number;
}> {
  const where: Record<string, unknown> = {};

  if (params.resourceType) where.resourceType = params.resourceType;
  if (params.resourceId) where.resourceId = params.resourceId;
  if (params.action) where.action = params.action;
  if (params.actorType) where.actorType = params.actorType;
  if (params.actorId) where.actorId = params.actorId;

  if (params.startDate || params.endDate) {
    where.createdAt = {};
    if (params.startDate) (where.createdAt as Record<string, Date>).gte = params.startDate;
    if (params.endDate) (where.createdAt as Record<string, Date>).lte = params.endDate;
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: params.limit || 100,
      skip: params.offset || 0,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total };
}

/**
 * Get audit trail for a specific resource
 */
export async function getResourceAuditTrail(
  resourceType: ResourceType,
  resourceId: string
): Promise<Array<{
  id: string;
  action: string;
  actorType: string;
  actorId: string | null;
  metadata: unknown;
  createdAt: Date;
}>> {
  return prisma.auditLog.findMany({
    where: {
      resourceType,
      resourceId,
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      action: true,
      actorType: true,
      actorId: true,
      metadata: true,
      createdAt: true,
    },
  });
}

export default {
  logAudit,
  logSearch,
  logEnrichment,
  logIdentityAction,
  logPiiAccess,
  queryAuditLogs,
  getResourceAuditTrail,
};
