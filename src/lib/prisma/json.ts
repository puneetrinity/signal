import { Prisma } from '@prisma/client';

/** Single contained cast for JSON values going into Prisma */
export function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
