import * as functions from "firebase-functions";
import admin from 'firebase-admin';
import { ProactiveEngine } from "./ProactiveEngine/ProactiveEngine";
import { DEFAULT_SETTINGS } from "./ProactiveEngine/types";
import { FirestoreService } from "./ProactiveEngine/firestoreService";


admin.initializeApp();
export const db = admin.firestore();

// Collezione Firestore per memorizzare gli stati dei mazzi
const deckStates = db.collection("deckStates");

export const index = functions.https.onRequest(async (req, res) => {
    let retValue = "0";

    try {
        const username = req.query.usernname as string;
        const password = req.query.password as string;

        // 🔐 VALIDAZIONE UTENTE (ex stored procedure UpS_Users_Api)
        const userSnap = await db
            .collection("users")
            .where("username", "==", username)
            .where("password", "==", password)
            .limit(1)
            .get();

        if (userSnap.empty) {
            res.send("0"); // credenziali errate
            return;
        }

        const userId = userSnap.docs[0].id;

        // 📥 Estrai parametri
        const computer = req.query.COMPUTER as string;
        const tavolo = req.query.TAVOLO as string;
        const margine = req.query.MARGINE as string;
        const colpoMartingala = req.query.COLPO_MARTINGALA as string;
        const pbt = req.query.PBT as string;
        const mazzo = req.query.MAZZO as string;
        const tempo = req.query.TEMPO as string;

        const hasCompleteData = computer && tavolo && pbt && margine &&
                                colpoMartingala && mazzo;

        // 💾 Salva parametri request in Firestore (ex upI_Values)
        const valuesBatch = db.batch();
        Object.keys(req.query).forEach(k => {
            if (k.toLowerCase() !== "username" && k.toLowerCase() !== "password") {
                const ref = db.collection("values").doc();
                valuesBatch.set(ref, {
                    key: k,
                    value: req.query[k],
                    userId,
                    timestamp: new Date(),
                    skipSave: Object.keys(req.query).length === 3 ? 1 : 0
                });
            }
        });
        await valuesBatch.commit();

        // 🚀 SE MANCANO DATI STOPPIAMO QUI
        if (!hasCompleteData) {
            res.send(retValue);
            return;
        }

        try {
            const tableId = parseInt(tavolo);
            const margineValue = parseFloat(margine.replace(",", "."));
            const martingalaLevel = parseInt(colpoMartingala) + 1;
            const esito = pbt.toUpperCase() === "B" ? "B" : pbt.toUpperCase() === "T" ? "T" : "P";
            const carteRimaste = parseInt(mazzo);

            const deckKey = `${username}_${computer}_${tableId}`;
            const deckDoc = deckStates.doc(deckKey);
            const deckSnap = await deckDoc.get();

            let deckState = deckSnap.exists
                ? deckSnap.data()!
                : { LastMazzo: carteRimaste, HandIndex: 0, CarteTotali: 416 };

            // 🔁 LOGICA MAZZO (pari pari all'originale)
            if (carteRimaste > deckState.LastMazzo && carteRimaste > deckState.CarteTotali - 20) {
                deckState.CarteTotali = carteRimaste > 450 ? 520 :
                                        carteRimaste > 350 ? 416 :
                                        carteRimaste > 250 ? 312 : 416;
                deckState.HandIndex = 0;
                deckState.LastMazzo = carteRimaste;
                console.log("NUOVO MAZZO", `Computer=${computer}, Table=${tableId}, Carte=${carteRimaste}`);
            }

            const carteDiff = deckState.LastMazzo - carteRimaste;
            if (carteDiff < 0) {
                const carteGiocate = deckState.CarteTotali - carteRimaste;
                deckState.HandIndex = Math.max(0, Math.floor(carteGiocate / 4));
                deckState.LastMazzo = carteRimaste;
            }

            if (carteDiff >= 4) {
                deckState.HandIndex += Math.floor(carteDiff / 4);
                deckState.LastMazzo = carteRimaste;
            }

            await deckDoc.set(deckState, { merge: true });

            const handIndexMazzo = deckState.HandIndex > 0 ? deckState.HandIndex : 1;

            // ⏱ tempo trascorso
            let elapsedMinutes = 0;
            if (tempo && tempo.includes(":")) {
                const [h, m] = tempo.split(":").map(Number);
                elapsedMinutes = h * 60 + m;
            }

            // 🔥 HOT ZONE
            const hz = handIndexMazzo;
            const isInHotZone = (hz >= 11 && hz <= 20) ||
                                (hz >= 41 && hz <= 50) ||
                                (hz >= 51 && hz <= 60) ||
                                (hz >= 61 && hz <= 70);

            // 🧠 PROACTIVE ENGINE
            const engine = new ProactiveEngine(new FirestoreService(db, "DEFAULT"), DEFAULT_SETTINGS);
            const advice = await engine.feedAndDecide(
                tableId,
                handIndexMazzo,
                margineValue,
                martingalaLevel,
                false,
                isInHotZone,
                esito,
                elapsedMinutes,
                1
            );

            // 🟢 ACTION CODE
            let actionCode = 0;
            const reason = advice.reason.toLowerCase();

            if (reason.includes("stop") || advice.prediction === "Disabled" ||
                advice.tableStatus.includes("Disabled") ||
                advice.tableStatus.includes("🔴") || advice.stopAtL5) {
                actionCode = 1;
            } else if (reason.includes("azzera") || reason.includes("reset") ||
                       reason.includes("safewin") || reason.includes("martingala")) {
                actionCode = 2;
            } else if (reason.includes("start") || reason.includes("avvia")) {
                actionCode = 3;
            }

            retValue = actionCode.toString();
        }
        catch (engineEx) {
            console.log("ProactiveEngine ERROR", engineEx);
            retValue = "9";
        }

        res.send(retValue);
        return;

    } catch (ex) {
        console.log("Page_Load", ex);
        res.send("9");
        return;
    }
});
