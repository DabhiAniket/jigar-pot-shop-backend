import { Router } from 'express';
import { homeContentSchema, storeSettingsSchema, type HomeContentDTO } from '@jmh/shared';
import type { AppContext } from '../../context';
import { HomeContentModel, StoreSettingsModel } from '../../db/models';
import { parseInput } from '../../lib/validate';
import { requirePermission } from '../../middleware/auth';
import { resolveImageRefs } from '../../media/media.service';
import { imageDTO } from '../../media/serialize';
import { audit } from '../audit/audit.service';
import { getHomeContent, getStoreSettings, invalidateSettingsCache } from './settings.service';

export function settingsAdminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get('/settings', requirePermission('settings:read'), async (_req, res) => {
    invalidateSettingsCache();
    const settings = await getStoreSettings();
    const { _id, updatedBy, createdAt, ...data } = settings;
    void _id;
    void updatedBy;
    void createdAt;
    res.set('Cache-Control', 'no-store').json({
      data: { ...data, whatsappFallbackFromEnv: ctx.config.whatsappNumber },
    });
  });

  router.put('/settings', requirePermission('settings:write'), async (req, res) => {
    const input = parseInput(storeSettingsSchema, req.body);
    const previous = await getStoreSettings();
    const policiesChanged =
      JSON.stringify(previous.policies ?? {}) !== JSON.stringify(input.policies);
    await StoreSettingsModel.updateOne(
      { _id: 'store' },
      {
        $set: {
          ...input,
          updatedBy: req.admin!.id,
          ...(policiesChanged ? { policiesUpdatedAt: new Date() } : {}),
        },
      },
      { upsert: true },
    );
    invalidateSettingsCache();
    void ctx.cache.invalidate('settings');
    ctx.revalidator.notify(['settings']);
    await audit(req, {
      action: 'settings.update',
      entityType: 'settings',
      entityId: 'store',
      summary: 'Updated store settings',
      metadata: {
        deliveryBefore: previous.delivery,
        deliveryAfter: input.delivery,
        whatsappChanged: previous.whatsappNumber !== input.whatsappNumber,
      },
    });
    res.status(204).end();
  });

  router.get('/content/home', requirePermission('content:write'), async (_req, res) => {
    const content = await getHomeContent();
    const data: HomeContentDTO = {
      hero: { ...content.hero, image: imageDTO(content.hero.image, ctx.storage) },
      story: content.story,
      craft: content.craft,
      featuredCategoryIds: content.featuredCategoryIds,
      sections: content.sections,
    };
    res.set('Cache-Control', 'no-store').json({ data });
  });

  router.put('/content/home', requirePermission('content:write'), async (req, res) => {
    const input = parseInput(homeContentSchema, req.body);
    const [image] = input.hero.image
      ? await resolveImageRefs([input.hero.image], 'hero.image')
      : [null];
    await HomeContentModel.updateOne(
      { _id: 'home' },
      {
        $set: { ...input, hero: { ...input.hero, image: image ?? null }, updatedBy: req.admin!.id },
      },
      { upsert: true },
    );
    void ctx.cache.invalidate('catalog');
    ctx.revalidator.notify(['home']);
    await audit(req, {
      action: 'content.home_update',
      entityType: 'content',
      entityId: 'home',
      summary: 'Updated homepage content',
    });
    res.status(204).end();
  });

  return router;
}
