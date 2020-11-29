const functions = require("firebase-functions");
const request = require("request");

var admin = require("firebase-admin");
var serviceAccount = require("./leasemagnets-adminsdk.json");

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://leasemagnets---dummy-db.firebaseio.com"
});

const backend_url = "http://localhost:8080";  // TODO how to determine production v dev?

// https://firebase.google.com/docs/functions/write-firebase-functions
// exports.helloWorld = functions.https.onRequest((request, response) => {
//     functions.logger.info("Hello logs!", { structuredData: true });
//     response.send("Hello from Firebase!");
// });

// exports.scheduledFunction = functions.pubsub.schedule("every 2 minutes").onRun((context) => {
//     console.log("This will be run every 2 minutes!");
//     functions.logger.info("Hello logs! 2 minutes", { structuredData: true });
//     return null;
// });

// exports.sendReportingEmail = functions.https.onRequest((request, response) => {
//     functions.logger.info("Hello logs!", { structuredData: true });
//     response.send("Hello from Firebase!");
// });


function formatDate(dateString) {
    var date = new Date(dateString);

    var month = '' + (date.getMonth() + 1);
    var day = '' + date.getDate();
    var year = date.getFullYear();
    var hour = '' + date.getHours();
    var min = '' + date.getMinutes();

    if (month.length < 2) month = '0' + month;
    if (day.length < 2) day = '0' + day;
    if (hour.length < 2) month = '0' + month;
    if (min.length < 2) day = '0' + day;

    return month + '/' + day + '/' + year + ", " + hour + ':' + min;
}


function sendBackendPOST(path, jsonData, responseHandler = undefined) {
    // `responseHandler` is an optional parameter, should be a function taking `res` and `body` parameters
    // You should pass a response handler if whatever path you're POSTing to on the backend might e.g.
    // send another request that could fail, and return the failed response
    functions.logger.info("POSTing new lead data to " + path);
    request.post({
        url: backend_url + path,
        body: jsonData,
        json: true
    }, function(error, res, body) {
        if (!error) {
            functions.logger.info("POSTed new lead data to " + path);
            if (responseHandler !== undefined) {
                responseHandler(res, body);
            }
        } else {
            // Only called when POST to backend fails, the backend POST could be successful but
            // could send another request that fails, which would go to `responseHandler`
            functions.logger.error("POST to " + path + " failed:");
            functions.logger.error(error);
        }
    });
}


// https://medium.com/codingthesmartway-com-blog/introduction-to-firebase-cloud-functions-c220613f0ef
exports.insertNewLead = functions.https.onRequest((req, res) => {

    // This function pulls data from Firestore and POSTs to the backend, but returns before
    // those actions are complete
    // This will create the customer doc and add a "leads" collection if it doesn't exist already,
    // but that doc won't have e.g. an "integrations" collection or any "branding"/"company_info" fields
    
    var responseString;

    if (req.method !== "POST") {
        responseString = "insertNewLead() should receive a POST request";
        res.send(responseString);
        return responseString;
    }

    /*
    Expecting these fields in POST request body:
        "formID": (string)
        "name": (string)
        "email": (string of comma-separated emails)
        "phone": (string)
        "leased": (bool)
        "source": (string)
        "tourTime": (string timestamp)
        "tourPath": (list of strings)
        Optional:
        "isTestRequest": (bool) // If true, don't push to integrations
    */

    var firestoreDoc = admin.firestore().collection("videoembed").doc(req.body.formID);

    functions.logger.info("Received new lead:");
    functions.logger.info(req.body, { structuredData: true });

    // Insert new lead into Firestore

    const firestoreNewLeadData = {
        "answers": req.body.tourPath,
        "created_at": req.body.tourTime,
        "email": req.body.email,
        "leased": req.body.leased,
        "name": req.body.name,
        "phone": req.body.phone,
        "source": req.body.source,
        "updated_at": admin.firestore.Timestamp.now()
    };

    firestoreDoc.collection("leads").doc(firestoreNewLeadData.email).set(firestoreNewLeadData);
    responseString = "Inserted new lead into Firestore";
    functions.logger.info(responseString);

    // Send new lead to integrations (if `req` is not a test request)

    // Check if "isTestRequest" is included and if it's true
    if (req.body.isTestRequest && req.body.isTestRequest === true) {
        functions.logger.info("insertNewLead received a test request, inserting to Firestore but not pushing to integrations");
    } else {
        
        // Is there a better way to get fields + collections from Firestore than nesting get()'s?
        // Another option would be to make branding and company_info collections rather than fields,
        // but that might not make anything simpler
        firestoreDoc.get().then(snapshot => {

            const docData = snapshot.data();
            const companyInfo = docData.company_info,
                promos = docData.promos,
                branding = docData.branding;

            firestoreDoc.collection("integrations").get().then(snapshot => {

                snapshot.forEach(integration => {

                    integrationData = integration.data();

                    if (integrationData.live === true) {
                        functions.logger.info("Found live integration: " + integration.id);

                        switch (integration.id) {
                        case "entrata":

                            // Entrata is generally set to live = false so we don't push to them too much :)
                            // Make sure to change turn it on for testing

                            const entrataNewLeadData = {
                                "creds": {
                                    "username": integrationData.username,
                                    "password": integrationData.password
                                },
                                "property_id": integrationData.property_id,
                                "originating_source_id": integrationData.originating_source_id,
                                "first_name": req.body.name.substr(0, req.body.name.indexOf(' ')),
                                "last_name": req.body.name.substr(req.body.name.indexOf(' ') + 1),
                                "email": req.body.email,
                                "phone": req.body.phone,
                                "video_journey": req.body.tourPath.join('\n'),
                                "notes": ""
                            };

                            // Include responseHandler function to capture entrata ID and push to Firestore
                            sendBackendPOST("/integrations/entrata/sendLeads", entrataNewLeadData, (res, body) => {
                                if (body.response.result.prospects.prospect[0].status === "Success") {
                                    functions.logger.info("POST to Entrata was successful");
                                    functions.logger.info("Pushing Entrata applicant ID "
                                                          + body.response.result.prospects.prospect[0].applicantId
                                                          + " and application ID "
                                                          + body.response.result.prospects.prospect[0].applicationId
                                                          + " to Firestore");
                                    firestoreDoc.collection("leads").doc(req.body.email).update({
                                        "entrata": {
                                            "applicant_id": body.response.result.prospects.prospect[0].applicantId,
                                            "application_id": body.response.result.prospects.prospect[0].applicationId
                                        }
                                    });
                                } else {
                                    functions.logger.warn("POST to Entrata failed: "
                                        + body.response.result.prospects.prospect[0].message);
                                }
                            });

                            break;

                        case "email-team":

                            const emailNewLeadData = {
                                "lColor": branding.gradient.l_color,
                                "rColor": branding.gradient.r_color,
                                // Different email field in case company want to send new lead info to a specific email
                                "cmpEmails": integrationData.team_email,
                                "company": companyInfo.name,
                                "leadName": req.body.name,
                                "code": promos[0].code,
                                "option": req.body.source,
                                "dateTime": formatDate(req.body.tourTime),
                                "leadEmail": req.body.email,
                                "leadNum": req.body.phone,
                                "tourPath": req.body.tourPath.join('\n')
                            };

                            sendBackendPOST("/email/newLead", emailNewLeadData);

                            break;

                        case "email-lead-promo":

                            // Only 1 promo code for now
                            if (promos[0].live === false) {
                                functions.logger.warn("email-lead-promo integration is live, but the first promo code is not");
                                break;
                            }

                            const emailPromoData = {
                                "lColor": branding.gradient.l_color,
                                "rColor": branding.gradient.r_color,
                                "leadEmail": req.body.email,
                                "leadName": req.body.name,
                                "company": companyInfo.name,
                                "cmpEmails": companyInfo.email,
                                "cmpRep": companyInfo.rep_name,
                                "cmpSite": companyInfo.website,
                                "cmpNum": companyInfo.phone,
                                "cmpAddy": (companyInfo.address.street_address
                                            + ", " + companyInfo.address.city
                                            + " " + companyInfo.address.state
                                            + " " + companyInfo.address.zip),
                                "fee": promos[0].fee_name,
                                "code": promos[0].code,
                                "amount": '$' + promos[0].value,
                                "selfie": companyInfo.social.selfie,
                                "fb": companyInfo.social.fb,
                                "insta": companyInfo.social.insta,
                                "twitter": companyInfo.social.twitter,
                                "regLink": companyInfo.regLink
                            };

                            sendBackendPOST("/email/promo", emailPromoData);

                            break;

                        default:
                            functions.logger.warn("Unknown live integration: " + integration.id);
                            break;
                        }
                    }

                });

            });

            responseString = "Pushed new lead to integrations"; // TODO: This is never sent since we're in a Firebase async call...

        }).catch(reason => {
            responseString = reason;
        });
    }

    res.send(responseString);
    return responseString;
});


exports.getLeads = functions.https.onRequest(async (req, res) => {
    
    // Expecting a "formID" field in the request query

    var response;

    // https://gist.github.com/CodingDoug/814a75ff55d5a3f951f8a7df3979636a
    const docRef = admin.firestore().collection("videoembed").doc(req.query.formID)
    const doc = await docRef.get();

    if (doc.exists) {
        const leads = await docRef.collection("leads").get();

        response = [];
        
        leads.forEach(lead => {
            response.push(lead.data());
        });

        res.status(200).send(response);
    } else {
        response = "Error: no document with ID " + req.query.formID;
        res.status(404).send(response);
    }

    return response;
});
