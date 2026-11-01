import { afterAll, describe, expect, it } from "vitest";
import { approvedPhoto, completeAtStation, openRegistrationContest, selfRegister } from "./helpers/categoryFixtures";
import { newPerson, pool, q, supabaseUrl } from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
requireLocalSupabase(supabaseUrl);
afterAll(async () => pool.end());

describe("four-category photos and WhatsApp expire seven days after the last scheduled category closes", () => {
  it("keeps fresh data, erases all renditions and contact after seven days, and is idempotent", async () => {
    const c = await openRegistrationContest();
    const r = c.rounds.MOST_ELABORATE;
    const entry = await selfRegister(r, await newPerson());
    const photo = await completeAtStation(r, entry.entry_id);
    const [row]=await q("select label from community_voting_entries where entry_id=$1",[entry.entry_id]);
    const alias=String(row.label).replace(/^#/,"");
    expect(await q("select * from read_community_voting_round_photo($1,$2,'thumb')",[r.instanceId,alias])).toHaveLength(1);
    await expect(q("update community_voting_registrations set whatsapp_e164=null,contact_deleted_at=now() where entry_id=$1",[entry.entry_id])).rejects.toThrow(/IMMUTABLE/);
    await q("select * from erase_expired_community_voting_media()");
    expect((await q("select full_bytes is not null present from community_voting_entry_photos where photo_id=$1", [photo.photoId]))[0].present).toBe(true);
    const ids = Object.values(c.rounds).map(x => x.instanceId);
    await q("update community_voting_schedules set registration_opens_at=now()-interval '10 days',contestant_cutoff_at=now()-interval '9 days',voting_opens_at=now()-interval '9 days',voting_closes_at=now()-interval '8 days' where instance_id=any($1::uuid[])", [ids.slice(0,3)]);
    await q("select * from erase_expired_community_voting_media()");
    expect((await q("select whatsapp_e164 is not null retained from community_voting_registrations where entry_id=$1",[entry.entry_id]))[0].retained).toBe(true);
    // Synthetic, unopened schedules can be moved into the past without changing the production clock or bypassing guards.
    await q("update community_voting_schedules set registration_opens_at=now()-interval '10 days',contestant_cutoff_at=now()-interval '9 days',voting_opens_at=now()-interval '9 days',voting_closes_at=now()-interval '8 days' where instance_id=any($1::uuid[])", [ids]);
    expect(await q("select * from read_community_voting_round_photo($1,$2,'thumb')",[r.instanceId,alias])).toHaveLength(0);
    const before = await q("select * from community_voting_candidacies where contest_id=$1", [c.contestId]);
    await q("select * from erase_expired_community_voting_media()");
    expect((await q("select full_bytes,thumb_bytes,bytes_deleted_reason from community_voting_entry_photos where photo_id=$1",[photo.photoId]))[0]).toEqual({full_bytes:null,thumb_bytes:null,bytes_deleted_reason:"RETENTION_EXPIRED"});
    const [contact] = await q("select whatsapp_e164,contact_deleted_at is not null erased from community_voting_registrations where entry_id=$1",[entry.entry_id]);
    expect(contact).toEqual({whatsapp_e164:null,erased:true});
    await expect(q("select * from read_community_voting_registration_contact($1,$2,$3,$4)",[r.instanceId,r.ctx.hostToken,r.ctx.operatorMemberId,entry.entry_id])).rejects.toThrow(/CV_WRONG_ENTRY_KIND/);
    expect(await q("select * from community_voting_candidacies where contest_id=$1", [c.contestId])).toEqual(before);
    await expect(approvedPhoto(r,entry.entry_id)).rejects.toMatchObject({code:"CUTOFF_PASSED"});
    await expect(q("insert into community_voting_entry_photos select * from community_voting_entry_photos where photo_id=$1",[photo.photoId])).rejects.toThrow(/CV_PREPARATION_CLOSED/);
    await expect(q("select * from erase_expired_community_voting_media()")).resolves.toBeTruthy();
    await expect(q("update community_voting_registrations set whatsapp_e164='+50499999999' where entry_id=$1",[entry.entry_id])).rejects.toThrow(/IMMUTABLE/);
  });
  it("uses the latest category close, not the earliest, with no winner exemption or caller clock", async () => {
    const c = await openRegistrationContest();
    const [row] = await q("select community_voting_retention_due($1) > now()+interval '6 days' future",[c.contestId]);
    expect(row.future).toBe(true);
    for (const role of ["anon","authenticated","service_role"]) {
      const [p] = await q("select has_function_privilege($1,'erase_expired_community_voting_media()','execute') allowed",[role]);
      expect(p.allowed).toBe(false);
    }
    const [job]=await q("select schedule,active from cron.job where jobname='community-voting-seven-day-retention'");
    expect(job).toEqual({schedule:"* * * * *",active:true});
  });
});
