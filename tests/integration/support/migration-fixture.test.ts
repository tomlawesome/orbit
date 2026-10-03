import { describe, expect, it } from "vitest";
import { EXPECTED_INDEXES, readSchemaContract } from "./migration-fixture";

// T-Q1 (#1151): readSchemaContract used to drop any index whose name was not
// already a key in EXPECTED_INDEXES before returning the result, so
// `expect(contract.indexes).toEqual(EXPECTED_INDEXES)` in migrations.test.ts
// could never see a stray extra index -- it was filtered out before the
// comparison ran. This test proves a stray index now survives the read so
// the contract comparison can actually catch it.
function fakeClient(responses: readonly unknown[][]) {
  let call = 0;
  return {
    unsafe: async () => responses[call++] ?? [],
  } as unknown as Parameters<typeof readSchemaContract>[0];
}

describe("readSchemaContract", () => {
  it("reports an index that is not in EXPECTED_INDEXES instead of silently dropping it", async () => {
    const strayIndexName = "idx_totally_unexpected_stray_index";
    expect(EXPECTED_INDEXES[strayIndexName]).toBeUndefined();

    const client = fakeClient([
      [], // enums
      [], // columns
      [], // constraints
      [
        {
          table_name: "households",
          index_name: strayIndexName,
          is_unique: false,
          columns: ["email"],
        },
      ], // indexes
    ]);

    const { indexes } = await readSchemaContract(client);

    expect(indexes).toHaveProperty(strayIndexName);
    expect(indexes[strayIndexName]).toEqual({
      table: "households",
      columns: ["email"],
      unique: false,
    });
  });
});
