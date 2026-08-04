import { z } from 'zod';
import { OWNER_VALUES } from '@/lib/constants';

export const assetSchema = z.object({
  asset_name: z.string().min(1),
  asset_class: z.enum(['cash', 'property', 'vehicle', 'business', 'other']).default('other'),
  current_value: z.number().min(0),
  currency_code: z.enum(['AUD', 'INR']),
  country_code: z.enum(['AU', 'IN']).optional(),
  valuation_date: z.string().date().optional(),
  purchase_price: z.number().min(0).optional(),
  purchase_date: z.string().date().optional(),
  owner: z.enum(OWNER_VALUES).default('self'),
  master_item_key: z.string().optional(),
  notes: z.string().optional(),
});

export type AssetInput = z.infer<typeof assetSchema>;
