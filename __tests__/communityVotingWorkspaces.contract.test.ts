import { afterAll, describe, expect, it } from "vitest";
import { newContest, registrationWindow, selfRegister } from "./helpers/categoryFixtures";
import { newPerson, pool, q, supabaseUrl, sessionRepo, rawClient, sleep } from "./helpers/roundsFixtures";
import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
requireLocalSupabase(supabaseUrl);
afterAll(async () => pool.end());
const open = (c: Awaited<ReturnType<typeof newContest>>, member = c.operator.gamingMemberId) => {
  const r = c.rounds.MOST_ELABORATE;
  return q("select * from open_community_voting_registration_atomically($1,$2,$3)", [r.instanceId, r.ctx.hostToken, member]);
};
describe("manual registration is independent of Session voting and clocks", () => {
  it("does not admit registration merely because the clock entered its window", async () => {
    const c = await newContest(registrationWindow());
    await expect(selfRegister(c.rounds.MOST_ELABORATE, await newPerson())).rejects.toThrow(/CV_REGISTRATION_NOT_OPEN/);
  });
  it("only the operator opens all categories, idempotently, without opening Voting", async () => {
    const c = await newContest(registrationWindow());
    await expect(open(c, (await newPerson()).gamingMemberId)).rejects.toThrow(/CV_OPERATOR_REQUIRED/);
    await Promise.all([open(c), open(c)]);
    const rows = await q("select * from community_voting_registration_openings where contest_id=$1", [c.contestId]);
    expect(rows).toHaveLength(1);
    await expect(selfRegister(c.rounds.MOST_ELABORATE, await newPerson())).resolves.toBeTruthy();
    const [{ n }] = await q<{ n: string }>("select count(*) n from interaction_instances i join community_voting_instances v on v.session_id=i.session_id join community_voting_category_rounds r on r.instance_id=v.instance_id where r.contest_id=$1", [c.contestId]);
    expect(Number(n)).toBe(0);
  });
  it("does not open before the approved window, and direct insertion cannot manufacture the opening", async () => {
    const c = await newContest({ ...registrationWindow(), registrationOpensAt: new Date(Date.now()+60000).toISOString() });
    await expect(open(c)).rejects.toThrow(/CV_REGISTRATION_NOT_OPEN/);
    await expect(q("insert into community_voting_registration_openings(contest_id,operator_gaming_member_id) values($1,$2)", [c.contestId,c.operator.gamingMemberId])).rejects.toThrow(/COMMUNITY_VOTING_ROUND_PATH_REQUIRED/);
  });
  it("keeps purpose immutable and rejects Home listing for a rehearsal in the database", async () => {
    const p=await newPerson(), s=await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo,s.sessionId,s.hostToken,["VOTING"] as never);
    const [r]=await q<{ instance_id: string; contest_id: string }>("select * from register_community_voting_workspace_category($1,$2,$3,1,null,'MOST_ELABORATE','REHEARSAL')",[s.sessionId,s.hostToken,p.gamingMemberId]);
    expect((await q("select purpose from community_voting_contests where contest_id=$1",[r.contest_id]))[0].purpose).toBe("REHEARSAL");
    await expect(q("select * from open_community_voting_registration_atomically($1,$2,$3)",[r.instance_id,s.hostToken,p.gamingMemberId])).rejects.toThrow(/CV_INVALID_REQUEST/);
    await expect(q("update community_voting_contests set purpose='LIVE' where contest_id=$1",[r.contest_id])).rejects.toThrow(/IMMUTABLE/);
    await expect(q("select * from set_community_voting_contest_listing_atomically($1,$2,$3,true)",[r.instance_id,s.hostToken,p.gamingMemberId])).rejects.toThrow(/CV_INVALID_REQUEST/);
    await expect(q("update community_voting_contests set listed_at=now(),listed_by_member_id=$2 where contest_id=$1",[r.contest_id,p.gamingMemberId])).rejects.toThrow(/CV_INVALID_REQUEST/);
    await expect(q("select * from register_community_voting_workspace_category($1,$2,$3,1,$4,'SEXIEST','LIVE')",[s.sessionId,s.hostToken,p.gamingMemberId,r.contest_id])).rejects.toThrow(/CV_INVALID_REQUEST/);
  });
  it("refuses partial contests and expired windows without creating an opening",async()=>{
    const c=await newContest({...registrationWindow(),cutoffAt:new Date(Date.now()-1000).toISOString()});
    await expect(open(c)).rejects.toThrow(/CV_REGISTRATION_NOT_OPEN/);
    expect(await q("select * from community_voting_registration_openings where contest_id=$1",[c.contestId])).toHaveLength(0);
  });
  it("one account can rehearse separately without consuming its real candidacy",async()=>{
    const a=await newContest({...registrationWindow(),purpose:"REHEARSAL"}), b=await newContest(registrationWindow()), p=await newPerson();
    await open(a);await open(b);
    const x=await selfRegister(a.rounds.MOST_ELABORATE,p),y=await selfRegister(b.rounds.MOST_ELABORATE,p);
    expect(x.entry_id).not.toBe(y.entry_id);
    const rows=await q("select contest_id,count(*)::int n from community_voting_registrations where contest_id=any($1::uuid[]) group by contest_id",[[a.contestId,b.contestId]]);
    expect(rows).toHaveLength(2);expect(rows.every(r=>r.n===1)).toBe(true);
  });
  it("checks the cutoff after waiting for Session locks, not before",async()=>{
    const c=await newContest({...registrationWindow(),cutoffAt:new Date(Date.now()+2000).toISOString()});
    const db=await rawClient();
    try {
      await db.query("begin");await db.query("select 1 from sessions where session_id=$1 for update",[c.rounds.MOST_ELABORATE.session.sessionId]);
      const waiting=expect(open(c)).rejects.toThrow(/CV_REGISTRATION_NOT_OPEN/);
      await sleep(2200);await db.query("commit");await waiting;
      expect(await q("select * from community_voting_registration_openings where contest_id=$1",[c.contestId])).toHaveLength(0);
    } finally {await db.query("rollback");await db.end();}
  });
  it("does not grant browser roles execute or table access",async()=>{
    const [r]=await q("select has_function_privilege('anon','open_community_voting_registration_atomically(uuid,text,uuid)','execute') a,has_function_privilege('authenticated','register_community_voting_workspace_category(uuid,text,uuid,integer,uuid,text,text)','execute') b,has_table_privilege('authenticated','community_voting_registration_openings','select,insert,update,delete') c");
    expect(r).toEqual({a:false,b:false,c:false});
  });
});
