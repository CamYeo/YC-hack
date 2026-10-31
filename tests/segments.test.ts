import { expect,test } from "bun:test"
import { splitIntoSegments } from "../shared/contracts"
test("speech segments preserve decimals and rejoin to the proposed text",()=>{
  for(const text of ["Try 1.5 seconds. Then wait 2.25 seconds.","HTTP 4.2 is not a failed charge. What happened?","A key identifies one operation."]){
    expect(splitIntoSegments(text).join(" ")).toBe(text)
  }
  expect(splitIntoSegments("Try 1.5 seconds. Then wait 2.25 seconds.")).toEqual(["Try 1.5 seconds.","Then wait 2.25 seconds."])
})
