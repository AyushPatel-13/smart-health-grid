// One-off: insert keys after anchor lines in en.ts / hi.ts.
import fs from "node:fs";

const patches = {
  "src/lib/i18n/en.ts": [
    ['    cancelled: "Cancelled",\n  },\n  txnType: {', '    dispatched: "Dispatched",\n    received: "Received",\n    replenishment_pending: "Replenishment pending",\n    closed: "Closed",\n    failed: "Failed",\n'],
    ['    expiry_writeoff: "Expiry write-off",\n', '    transfer_return: "Returned to donor",\n    replenishment_in: "Warehouse replenishment",\n    restoration_in: "Loan restoration",\n'],
    ['      manual: "Manual",\n    },\n    templates: {', '      restoration_overdue: "Restoration overdue",\n      replenishment_failed: "Replenishment failed",\n      workload_staffing: "Doctor workload",\n      attendance_review: "Attendance review",\n'],
    ['      stale_data: "No footfall report for {days} day(s)",\n', '      restoration_overdue: "{qty} {medicine} owed back since {due}",\n      replenishment_failed: "Replenishment {code} failed ({medicine})",\n      workload_staffing: "Demand exceeds safe doctor capacity on {date}",\n      attendance_review: "{count} attendance record(s) need review",\n'],
    ['    registerPatient: "Register patient",\n', '    distribution: "Medicine distribution",\n    workforce: "Doctor workforce",\n    myAttendance: "My attendance",\n'],
    ['    VISIT_NOT_FOUND: "Visit not found.",\n', '    TRANSFER_NOT_DISPATCHED: "The transfer has not been dispatched (or already failed).",\n    REPLENISHMENT_NOT_FOUND: "Replenishment request not found.",\n    LEDGER_NOT_FOUND: "Ledger entry not found.",\n    NO_SAFE_LENDER: "No facility can lend safely.",\n    RECOMMENDATION_STALE: "Stock has changed — the recommendation was recalculated. Please review it again.",\n    SHIFT_NOT_FOUND: "Shift not found.",\n    SHIFT_NOT_TODAY: "Check-in is only possible for today\'s shift.",\n    NOT_CHECKED_IN: "You have not checked in for this shift.",\n    STAFF_NOT_FOUND: "Staff member not found.",\n    STAFF_ON_LEAVE: "The doctor is on approved leave during that period.",\n    REASSIGNMENT_OVERLAP: "The doctor already has an approved reassignment in that period.",\n    DONOR_MIN_STAFFING: "The home centre would fall below its minimum doctor staffing.",\n'],
  ],
  "src/lib/i18n/hi.ts": [
    ['    cancelled: "रद्द",\n  },\n  txnType: {', '    dispatched: "भेजा गया",\n    received: "प्राप्त",\n    replenishment_pending: "पुनःपूर्ति लंबित",\n    closed: "बंद",\n    failed: "विफल",\n'],
    ['    expiry_writeoff: "समाप्ति राइट-ऑफ़",\n', '    transfer_return: "दाता को वापसी",\n    replenishment_in: "गोदाम पुनःपूर्ति",\n    restoration_in: "ऋण बहाली",\n'],
    ['      manual: "मैनुअल",\n    },\n    templates: {', '      restoration_overdue: "बहाली अतिदेय",\n      replenishment_failed: "पुनःपूर्ति विफल",\n      workload_staffing: "डॉक्टर कार्यभार",\n      attendance_review: "उपस्थिति समीक्षा",\n'],
    ['      stale_data: "{days} दिन से आगमन रिपोर्ट नहीं",\n', '      restoration_overdue: "{due} से {qty} {medicine_hi} लौटाना बाकी",\n      replenishment_failed: "पुनःपूर्ति {code} विफल ({medicine_hi})",\n      workload_staffing: "{date} को माँग सुरक्षित डॉक्टर क्षमता से अधिक",\n      attendance_review: "{count} उपस्थिति रिकॉर्ड समीक्षा हेतु",\n'],
    ['    registerPatient: "मरीज़ पंजीकरण",\n', '    distribution: "दवा वितरण",\n    workforce: "डॉक्टर कार्यबल",\n    myAttendance: "मेरी उपस्थिति",\n'],
    ['    VISIT_NOT_FOUND: "विज़िट नहीं मिली।",\n', '    TRANSFER_NOT_DISPATCHED: "स्थानांतरण भेजा नहीं गया (या पहले ही विफल)।",\n    REPLENISHMENT_NOT_FOUND: "पुनःपूर्ति अनुरोध नहीं मिला।",\n    LEDGER_NOT_FOUND: "खाता प्रविष्टि नहीं मिली।",\n    NO_SAFE_LENDER: "कोई केंद्र सुरक्षित उधार नहीं दे सकता।",\n    RECOMMENDATION_STALE: "स्टॉक बदल गया — अनुशंसा की पुनर्गणना हुई। कृपया फिर से देखें।",\n    SHIFT_NOT_FOUND: "शिफ़्ट नहीं मिली।",\n    SHIFT_NOT_TODAY: "चेक-इन केवल आज की शिफ़्ट के लिए संभव है।",\n    NOT_CHECKED_IN: "आपने इस शिफ़्ट में चेक-इन नहीं किया है।",\n    STAFF_NOT_FOUND: "कर्मचारी नहीं मिला।",\n    STAFF_ON_LEAVE: "उस अवधि में डॉक्टर स्वीकृत अवकाश पर हैं।",\n    REASSIGNMENT_OVERLAP: "उस अवधि में डॉक्टर का पहले से स्वीकृत पुनर्नियोजन है।",\n    DONOR_MIN_STAFFING: "मूल केंद्र न्यूनतम डॉक्टर संख्या से नीचे चला जाएगा।",\n'],
  ],
};

for (const [file, list] of Object.entries(patches)) {
  let s = fs.readFileSync(file, "utf8");
  for (const [anchor, insert] of list) {
    const i = s.indexOf(anchor);
    if (i < 0) throw new Error(`${file}: anchor not found: ${anchor.slice(0, 50)}`);
    // Insert right after the first line of the anchor.
    const lineEnd = s.indexOf("\n", i) + 1;
    s = s.slice(0, lineEnd) + insert + s.slice(lineEnd);
  }
  fs.writeFileSync(file, s);
  console.log("patched", file);
}
