/**
 * Common misspellings of everyday words, each with exactly one correction ("bad=good", "_" for a space in the
 * correction). Curated from public lists of frequent English misspellings and keyboard slips, then filtered: the
 * misspelling is not a word in the SCOWL English, American or British lists, every correction word is, and a
 * correction that is spelled differently in US and UK English is left out (the spelling-variant rule owns those).
 * Hand-added entries cover the email staples (tomorow, recieve, untill, wich, teh, alittle, thnaks, ...).
 *
 * One string instead of an object literal keeps the bundle small; the Map is built on first use.
 */
export const MISSPELLINGS_DATA = `
abandonned=abandoned abbout=about abilityes=abilities abilties=abilities abilty=ability abit=a_bit abondon=abandon
abondoned=abandoned abondoning=abandoning abondons=abandons abotu=about abreviate=abbreviate abreviated=abbreviated
abreviation=abbreviation abritrary=arbitrary abscence=absence absense=absence absolutley=absolutely
absolutly=absolutely acadmic=academic accademic=academic acccused=accused acceptence=acceptance
acceptible=acceptable accessable=accessible accidant=accident accidentaly=accidentally accidently=accidentally
accomadate=accommodate accomadation=accommodation accomdate=accommodate accomodate=accommodate
accomodation=accommodation accompanyed=accompanied accoring=according accoustic=acoustic accross=across
accussed=accused acedemic=academic acheive=achieve acheived=achieved acheivement=achievement
acheivements=achievements acheives=achieves acheiving=achieving acheivment=achievement acheivments=achievements
achievment=achievement achievments=achievements achivement=achievement achivements=achievements acident=accident
acitve=active acknowldeged=acknowledged acknowledgeing=acknowledging acommodate=accommodate acomplish=accomplish
acomplished=accomplished acording=according acordingly=accordingly acount=account acquaintence=acquaintance
acquiantence=acquaintance activites=activities activly=actively actualy=actually acuracy=accuracy acused=accused
acustom=accustom acustommed=accustomed adavanced=advanced adbandon=abandon addional=additional
addionally=additionally additinally=additionally additionaly=additionally additonal=additional
additonally=additionally addmission=admission addopt=adopt addopted=adopted addresed=addressed addresing=addressing
addressess=addresses addtion=addition addtional=additional adecuate=adequate adequit=adequate adhearing=adhering
admendment=amendment admininistrative=administrative adminstered=administered adminstration=administration
adminstrative=administrative admited=admitted admitedly=admittedly adn=and adquire=acquire adquired=acquired
adquires=acquires adquiring=acquiring adres=address adresing=addressing adress=address adressed=addressed
adventrous=adventurous advertisment=advertisement advertisments=advertisements adviced=advised
aforememtioned=aforementioned afternon=afternoon againnst=against agaisnt=against aganist=against aggreed=agreed
aggreement=agreement aggresive=aggressive agian=again agianst=against aginst=against agre=agree agred=agreed
agreeement=agreement agreemnt=agreement agreing=agreeing agressive=aggressive ahev=have ahppen=happen ahve=have
aicraft=aircraft aiport=airport aircaft=aircraft aircrafts=aircraft airrcraft=aircraft albiet=albeit
alchohol=alcohol alchoholic=alcoholic alchol=alcohol alcholic=alcoholic alcohal=alcohol alcoholical=alcoholic
aledge=allege aledged=alleged aledges=alleges alege=allege aleged=alleged algorhitms=algorithms algoritm=algorithm
algoritms=algorithms alittle=a_little alledgedly=allegedly allegedely=allegedly allegedy=allegedly
allegely=allegedly allign=align alligned=aligned alliviate=alleviate allready=already allthough=although
alltogether=altogether almsot=almost alochol=alcohol alomst=almost alowed=allowed alowing=allowing alraedy=already
alreayd=already alredy=already alsot=also alternitives=alternatives althought=although altough=although
alwasy=always alwyas=always amatuer=amateur amendmant=amendment amke=make amking=making ammend=amend
ammended=amended ammendment=amendment ammount=amount ammused=amused amoung=among amung=among analagous=analogous
analogeous=analogous anbd=and andd=and aniversary=anniversary annouced=announced annualy=annually anohter=another
anomolies=anomalies anomoly=anomaly anounced=announced anouncement=announcement ansestors=ancestors anual=annual
anwsered=answered anyhwere=anywhere anyother=any_other anytying=anything aobut=about aparent=apparent
aplication=application aplied=applied apparant=apparent apparantly=apparently appart=apart appeareance=appearance
appearence=appearance appearences=appearances apperance=appearance apperances=appearances appereance=appearance
appereances=appearances applicaiton=application applicaitons=applications appologies=apologies appology=apology
apprearance=appearance appriciate=appreciate appriciated=appreciated apprieciate=appreciate approachs=approaches
appropiate=appropriate appropraite=appropriate appropropiate=appropriate approproximate=approximate
approxamately=approximately approxiately=approximately approximitely=approximately apreciate=appreciate
apreciated=appreciated apropriate=appropriate aproval=approval aproximate=approximate aproximately=approximately
aquaintance=acquaintance aquiantance=acquaintance aquire=acquire aquired=acquired aquiring=acquiring
aquisition=acquisition aranged=arranged arangement=arrangement arbitarily=arbitrarily arbitary=arbitrary
archetecture=architecture archiac=archaic architechture=architecture aready=already argubly=arguably
arguement=argument arguements=arguments arised=arose arival=arrival arogant=arrogant arogent=arrogant aroud=around
arrangment=arrangement arrangments=arrangements arrengement=arrangement arrengements=arrangements arround=around
artcile=article artical=article artice=article articel=article artifical=artificial artifically=artificially
arund=around asfar=as_far asign=assign aslo=also asociated=associated asorbed=absorbed assemple=assemble
assertation=assertion asside=aside assistence=assistance assit=assist assitant=assistant assocation=association
assoicate=associate assoicated=associated assoicates=associates assualt=assault asthetic=aesthetic
asthetically=aesthetically asume=assume aswell=as_well atain=attain atempting=attempting athiesm=atheism
athiest=atheist atleast=at_least atorney=attorney atribute=attribute atributed=attributed atributes=attributes
attachement=attachment attachted=attached attahced=attached attatch=attach attatched=attached attatchment=attachment
attched=attached attemp=attempt attemped=attempted attemt=attempt attemted=attempted attemting=attempting
attemts=attempts attendence=attendance attendent=attendant attened=attended attension=attention attitide=attitude
attributred=attributed attrocities=atrocities audeince=audience auromated=automated authobiography=autobiography
authorites=authorities authorithy=authority authoritiers=authorities authrorities=authorities
automaticly=automatically automibile=automobile autority=authority availabe=available availabilty=availability
availablity=availability availaible=available availble=available availiable=available availible=available
avalable=available avaliable=available avilable=available awared=awarded awya=away bacame=became baceause=because
backgorund=background backrounds=backgrounds bakc=back banannas=bananas bandwith=bandwidth baout=about
basicaly=basically basicly=basically bcak=back beacuse=because beatiful=beautiful beaurocracy=bureaucracy
beautifull=beautiful beautyfull=beautiful becamae=became becasue=because becaus=because beccause=because
becomeing=becoming becomming=becoming becouse=because becuase=because bedore=before beeing=being befoer=before
begginer=beginner begginers=beginners beggining=beginning beggins=begins begining=beginning beginnig=beginning
beleif=belief beleive=believe beleived=believed beleives=believes beleiving=believing belive=believe
benificial=beneficial benifit=benefit benifits=benefits beteen=between betwen=between beween=between bewteen=between
bigining=beginning biginning=beginning bizzare=bizarre blaim=blame blaimed=blamed bondary=boundary boook=book
borke=broke boundry=boundary bradcast=broadcast breif=brief breifly=briefly brethen=brethren bretheren=brethren
briliant=brilliant brillant=brilliant broacasted=broadcast broadacasting=broadcasting broady=broadly
buisness=business burried=buried busines=business busness=business bussiness=business caculater=calculator
cahracters=characters calandar=calendar calander=calendar calculater=calculator calender=calendar
caluclate=calculate caluclated=calculated caluculate=calculate caluculated=calculated calulate=calculate
calulated=calculated calulater=calculator campagin=campaign campain=campaign campains=campaigns candadate=candidate
candiate=candidate candidiate=candidate cannnot=cannot cannonical=canonical cannotations=connotations caost=coast
caperbility=capability capible=capable captial=capital captued=captured capturd=captured carachter=character
carefull=careful careing=caring carreer=career carrers=careers carryng=carrying cartdridge=cartridge
cartrige=cartridge casue=cause casued=caused casues=causes casuing=causing catagories=categories catagory=category
cemetary=cemetery centruies=centuries centruy=century centuties=centuries centuty=century cerimony=ceremony
ceromony=ceremony certainity=certainty certaintly=certainly certian=certain chalenging=challenging
challange=challenge challanged=challenged challege=challenge changable=changeable charachter=character
charachters=characters charactersistic=characteristic charactor=character charactors=characters chariman=chairman
charistics=characteristics cheif=chief chemcial=chemical chemestry=chemistry childen=children choclate=chocolate
choosen=chosen chracter=character chuch=church churchs=churches circulaton=circulation circut=circuit
ciricuit=circuit ciriculum=curriculum civillian=civilian claer=clear claerer=clearer claerly=clearly claimes=claims
clasic=classic clasical=classical cleareance=clearance clera=clear clincial=clinical cmoputer=computer
coform=conform colelctive=collective collecton=collection collegue=colleague collegues=colleagues collony=colony
comany=company comapany=company combanations=combinations combinatins=combinations comdemnation=condemnation
comision=commission comisioned=commissioned comisioning=commissioning comisions=commissions comission=commission
comissioned=commissioned comissioning=commissioning comissions=commissions comited=committed comiting=committing
comitted=committed comittee=committee comitting=committing commerical=commercial commerically=commercially
commericial=commercial commericially=commercially comming=coming comminication=communication commision=commission
commisioned=commissioned commisioning=commissioning commisions=commissions commited=committed commitee=committee
commiting=committing committe=committee committment=commitment committments=commitments commongly=commonly
commuications=communications commuinications=communications communciation=communication communiation=communication
communites=communities compability=compatibility comparision=comparison comparisions=comparisons
comparitive=comparative comparitively=comparatively compatability=compatibility compatable=compatible
compatablity=compatibility compatiable=compatible compatiblity=compatibility compensantion=compensation
competance=competence competant=competent competative=competitive competitiion=competition competive=competitive
comphrehensive=comprehensive compitent=competent completelyl=completely completetion=completion completly=completely
componant=component comprable=comparable comprimise=compromise compulsary=compulsory compulsery=compulsory
concensus=consensus concider=consider concidered=considered concidering=considering conciders=considers
concieved=conceived concious=conscious conciously=consciously conciousness=consciousness condamned=condemned
condemmed=condemned condidtion=condition condidtions=conditions conected=connected conection=connection
conesencus=consensus confidental=confidential confortable=comfortable confrim=confirm
congradulations=congratulations conjecutre=conjecture conjuction=conjunction conotations=connotations
conscent=consent consciouness=consciousness consdider=consider consdidered=considered consdiered=considered
consectutive=consecutive consenquently=consequently consentrate=concentrate consentrated=concentrated
consentrates=concentrates consept=concept consequentually=consequently consequeseces=consequences consern=concern
conserned=concerned conserning=concerning conservitive=conservative consiciousness=consciousness
consicousness=consciousness considerd=considered consideres=considered consious=conscious consistant=consistent
consistantly=consistently consituency=constituency consitution=constitution consitutional=constitutional
constaints=constraints constanly=constantly constatn=constant constinually=continually constituant=constituent
constituants=constituents constituion=constitution constituional=constitutional consttruction=construction
constuction=construction consulant=consultant containes=contains contamporary=contemporary contempoary=contemporary
contempory=contemporary contian=contain contians=contains contibute=contribute contibuted=contributed
contibutes=contributes contined=continued continential=continental continous=continuous continously=continuously
continueing=continuing contravercial=controversial contraversy=controversy contributer=contributor
contributers=contributors contritutions=contributions controled=controlled controling=controlling controll=control
controlls=controls controvercial=controversial controvercy=controversy controversal=controversial
controversey=controversy controvertial=controversial controvery=controversy contruction=construction
contstruction=construction conveinent=convenient convential=conventional convertion=conversion conviced=convinced
convienient=convenient coordiantion=coordination copmetitors=competitors coputer=computer copywrite=copyright
cornmitted=committed corparate=corporate correponding=corresponding correposding=corresponding
correspondant=correspondent corrispond=correspond corrispondant=correspondent corrisponded=corresponded
corrisponding=corresponding corrisponds=corresponds costitution=constitution coucil=council counries=countries
countains=contains countires=countries creaeted=created critereon=criterion criterias=criteria criticists=critics
critisism=criticism critisisms=criticisms crowm=crown crtical=critical crutial=crucial cumulatative=cumulative
curcuit=circuit curiousity=curiosity currenly=currently curriculem=curriculum cyclinder=cylinder daed=dead
dammage=damage daugher=daughter decieve=deceive decison=decision decribe=describe decribed=described
decribes=describes decribing=describing dectect=detect defenitely=definitely deffine=define deffined=defined
definate=definite definately=definitely definatly=definitely definetely=definitely definetly=definitely
definining=defining definit=definite definitley=definitely definitly=definitely definiton=definition
defintely=definitely defintion=definition delevopment=development deliberatly=deliberately demorcracy=democracy
demostration=demonstration deparment=department deparmental=departmental deparments=departments deriviated=derived
derivitive=derivative derogitory=derogatory descibed=described descision=decision descisions=decisions
descriibes=describes descripton=description desctruction=destruction descuss=discuss desgined=designed
desicion=decision deside=decide desigining=designing desireable=desirable desitned=destined desktiop=desktop
desorder=disorder desparate=desperate dessigned=designed destory=destroy detailled=detailed detatched=detached
determinining=determining devasted=devastated develope=develop developement=development developped=developed
develpment=development devestated=devastated devestating=devastating devide=divide devided=divided
devistating=devastating devolopement=development diconnects=disconnects dicover=discover dicovered=discovered
dicovering=discovering dicovers=discovers dicovery=discovery dictionarys=dictionaries dicussed=discussed
diferent=different diferrent=different differnt=different difficulity=difficulty diffrent=different
dificulties=difficulties dificulty=difficulty dilema=dilemma dilemna=dilemma dimenions=dimensions
dimention=dimension dimentional=dimensional dimentions=dimensions dimesnional=dimensional directoty=directory
dirived=derived disagreeed=disagreed disapear=disappear disapeared=disappeared disapoint=disappoint
disapointed=disappointed disapointing=disappointing disappearred=disappeared disasterous=disastrous
disatrous=disastrous discribe=describe discribed=described discribes=describes discribing=describing
discription=description disctinction=distinction disctinctive=distinctive disover=discover dispair=despair
dispite=despite dispostion=disposition dissagreement=disagreement dissapear=disappear dissapeared=disappeared
dissapearing=disappearing dissapears=disappears dissapoint=disappoint dissapointed=disappointed dissappear=disappear
dissappears=disappears dissappointed=disappointed distiction=distinction distingish=distinguish
distingished=distinguished distingishes=distinguishes distingishing=distinguishing distingquished=distinguished
distrubution=distribution distruction=destruction distructive=destructive ditributed=distributed divice=device
divison=division divisons=divisions doccument=document doccumented=documented doccuments=documents
documenatry=documentary documnet=document doens=does doign=doing dominent=dominant dominiant=dominant donig=doing
doulbe=double dramtic=dramatic dreasm=dreams driectly=directly drnik=drink dupicate=duplicate durig=during
durring=during duting=during eachother=each_other eahc=each ealier=earlier eamil=email eceonomy=economy
ecomonic=economic econoimic=economic eearly=early effeciency=efficiency effecient=efficient effeciently=efficiently
efficency=efficiency efficent=efficient efficently=efficiently eiter=either elction=election electrial=electrical
electricty=electricity elementay=elementary eleminated=eliminated eleminating=eliminating eletricity=electricity
eligable=eligible elimentary=elementary ellected=elected elphant=elephant emali=email embarass=embarrass
embarassed=embarrassed embarassing=embarrassing embarassment=embarrassment embarras=embarrass embarrased=embarrassed
embarrasing=embarrassing embarrasment=embarrassment emial=email emmediately=immediately emminently=eminently
emperical=empirical emphsis=emphasis emprisoned=imprisoned enchancement=enhancement encouraing=encouraging
endig=ending enduce=induce enforceing=enforcing engeneer=engineer engeneering=engineering engieneer=engineer
engieneers=engineers enourmous=enormous enourmously=enormously enteratinment=entertainment enthusiatic=enthusiastic
entitity=entity entitlied=entitled enviorment=environment enviormental=environmental enviorments=environments
enviornment=environment enviornmental=environmental enviornments=environments enviroment=environment
enviromental=environmental enviroments=environments envolutionary=evolutionary envrionments=environments enxt=next
epidsodes=episodes epsiode=episode equalibrium=equilibrium equelibrium=equilibrium equialent=equivalent
equilibium=equilibrium equilibrum=equilibrium equiped=equipped equippment=equipment equiptment=equipment
equivelant=equivalent equivelent=equivalent equivilant=equivalent equivilent=equivalent equivlalent=equivalent
esential=essential esitmated=estimated esle=else especialy=especially essencial=essential essense=essence
essentail=essential essentialy=essentially essentual=essential essesital=essential estabishes=establishes
establising=establishing evenhtually=eventually evenign=evening eventally=eventually eventhough=even_though
eventially=eventually eventualy=eventually everthing=everything everytime=every_time everyting=everything
eveyr=every evidentally=evidently exagerate=exaggerate exagerated=exaggerated exagerates=exaggerates
exagerating=exaggerating exagerrate=exaggerate exagerrated=exaggerated exagerrates=exaggerates
exagerrating=exaggerating examinated=examined exampt=exempt exapansion=expansion excact=exact excange=exchange
excecute=execute excecuted=executed excecutes=executes excecuting=executing excecution=execution excedded=exceeded
excelent=excellent excellant=excellent excercise=exercise exchanching=exchanging excisted=existed
exculsivly=exclusively execising=exercising exection=execution exectued=executed exeedingly=exceedingly
exelent=excellent exellent=excellent exept=except exeptional=exceptional exerciese=exercises exersize=exercise
exerternal=external exhibtion=exhibition exibition=exhibition exicting=exciting existance=existence
existince=existence exludes=excludes exmaple=example expalin=explain expeced=expected expecially=especially
expeiments=experiments experiance=experience experianced=experienced expierence=experience explaination=explanation
explaning=explaining explictly=explicitly explotation=exploitation exressed=expressed extemely=extremely
extention=extension extentions=extensions extermist=extremist extrememly=extremely extremly=extremely
extrordinarily=extraordinarily extrordinary=extraordinary eyar=year eyars=years eyasr=years faciliate=facilitate
facilites=facilities facillitate=facilitate facinated=fascinated facinating=fascinating facist=fascist
familar=familiar familes=families familliar=familiar famoust=famous fatc=fact faught=fought feasable=feasible
febuary=February femminist=feminist fianite=finite fianlly=finally fidn=find fimilies=families finacial=financial
finaly=finally financialy=financially firends=friends flourescent=fluorescent followign=following follwing=following
follwoing=following folowing=following fomed=formed foootball=football forbiden=forbidden foriegn=foreign
formelly=formerly forseeable=foreseeable fortunatly=fortunately foucs=focus foudn=found fougth=fought fourty=forty
foward=forward freind=friend freindly=friendly frequentily=frequently frined=friend fucntion=function
fucntioning=functioning fufilled=fulfilled fulfiled=fulfilled fullfilled=fulfilled fundametal=fundamental
funtion=function furuther=further futher=further futhermore=furthermore galatic=galactic ganerate=generate
garantee=guarantee garanteed=guaranteed garantees=guarantees gaurantee=guarantee gauranteed=guaranteed
gaurantees=guarantees gaurd=guard gaurentee=guarantee gaurenteed=guaranteed gaurentees=guarantees generaly=generally
generatting=generating geographicial=geographical gerat=great goign=going gonig=going gouvener=governor
govement=government govenment=government govenrment=government goverment=government governer=governor
governmnet=government govorment=government govornment=government graet=great grafitti=graffiti grammer=grammar
gratefull=grateful gratuitious=gratuitous greatful=grateful greatfully=gratefully greif=grief gropu=group grwo=grow
guarentee=guarantee guarenteed=guaranteed guarentees=guarantees guidence=guidance gurantee=guarantee
guranteed=guaranteed gurantees=guarantees halarious=hilarious hapen=happen hapened=happened hapening=happening
happend=happened happended=happened happenned=happened happyness=happiness harrased=harassed harrass=harass
harrassment=harassment haviest=heaviest heared=heard heigher=higher heighth=height heirarchy=hierarchy
helment=helmet helpfull=helpful helpped=helped hertiage=heritage hieght=height hierachical=hierarchical
hierachy=hierarchy hierarcical=hierarchical hierarcy=hierarchy higer=higher higest=highest higway=highway
hillarious=hilarious himselv=himself hismelf=himself historicians=historians holliday=holiday honory=honorary
hopefuly=hopefully horrifing=horrifying howver=however hsitorians=historians hstory=history hte=the htey=they
htikn=think hting=thing htink=think htis=this humerous=humorous humurous=humorous husban=husband hvae=have
hvaing=having hwihc=which hwile=while hwole=whole hydogen=hydrogen hygene=hygiene hypocracy=hypocrisy
hypocrasy=hypocrisy hypocricy=hypocrisy hypocrit=hypocrite idaeidae=idea idaes=ideas identicial=identical
identifers=identifiers ideosyncratic=idiosyncratic ignorence=ignorance illess=illness illiegal=illegal
illution=illusion ilness=illness ilogical=illogical imagenary=imaginary imagin=imagine imaginery=imaginary
imcomplete=incomplete imediately=immediately imediatly=immediately imense=immense immediatley=immediately
immediatly=immediately immidately=immediately immidiately=immediately implamenting=implementing impliment=implement
implimented=implemented imploys=employs importamt=important imprioned=imprisoned imprisonned=imprisoned
improvments=improvements inablility=inability inaccessable=inaccessible inadiquate=inadequate inadquate=inadequate
inadvertantly=inadvertently inappropiate=inappropriate inbalance=imbalance inbetween=in_between incase=in_case
incidentially=incidentally incidently=incidentally inclreased=increased includ=include includng=including
incompatable=incompatible incompetance=incompetence incompetant=incompetent incomptable=incompatible
incomptetent=incompetent inconsistant=inconsistent incoroporated=incorporated incorportaed=incorporated
incorprates=incorporates increadible=incredible incredable=incredible inctroduce=introduce inctroduced=introduced
incuding=including indefinately=indefinitely indefinitly=indefinitely indentical=identical
indepedantly=independently indepedence=independence independance=independence independant=independent
independantly=independently independece=independence independendet=independent indictement=indictment
indipendence=independence indipendent=independent indipendently=independently indispensible=indispensable
individualy=individually indpendent=independent indpendently=independently indulgue=indulge indutrial=industrial
indviduals=individuals inevatible=inevitable inevitible=inevitable inevititably=inevitably infact=in_fact
infallable=infallible infinit=infinite influencial=influential influented=influenced infomation=information
inforamtion=information informaiton=information informtion=information infrigement=infringement
infromation=information ingenius=ingenious ingreediants=ingredients inhabitans=inhabitants inherantly=inherently
inheritence=inheritance inital=initial initally=initially initiaitive=initiative inlcuding=including
innoculate=inoculate inocence=innocence inofficial=unofficial inot=into inpending=impending inproving=improving
insensative=insensitive insistance=insistence insitution=institution insitutions=institutions instade=instead
instatance=instance insted=instead institue=institute instuction=instruction instuments=instruments
insurence=insurance intelectual=intellectual inteligence=intelligence inteligent=intelligent
intenational=international intepretation=interpretation interational=international interferance=interference
interfereing=interfering intergrated=integrated intergration=integration internation=international
interpet=interpret interrim=interim intertaining=entertaining interupt=interrupt intervines=intervenes
intevene=intervene intial=initial intially=initially intrduced=introduced intrest=interest intrested=interested
intresting=interesting introdued=introduced intruduced=introduced intrument=instrument intrumental=instrumental
intruments=instruments intutive=intuitive inudstry=industry investingate=investigate involvment=involvement
irelevent=irrelevant iritated=irritated irregardless=regardless irrelevent=irrelevant irresistable=irresistible
issueing=issuing itnroduced=introduced iwll=will iwth=with jorunal=journal jouney=journey jstu=just jsut=just
knowlege=knowledge knwo=know knwos=knows konw=know konws=knows kwno=know lable=label labratory=laboratory
laguage=language laguages=languages larg=large largst=largest launhed=launched lazyness=laziness leage=league
leathal=lethal lefted=left legitamate=legitimate legitmate=legitimate lenght=length leran=learn lerans=learns
levle=level liasion=liaison liason=liaison libary=library libguistic=linguistic lieing=lying liek=like liekd=liked
liesure=leisure liftime=lifetime likelyhood=likelihood litature=literature literaly=literally literture=literature
littel=little litterally=literally liuke=like livley=lively lmits=limits loev=love lonley=lonely lsat=last lveo=love
lvoe=love magasine=magazine magisine=magazine magizine=magazine magnificient=magnificent mailny=mainly
maintainance=maintenance maintainence=maintenance maintance=maintenance maintenence=maintenance
maintinaing=maintaining maintioned=mentioned majoroty=majority makse=makes managment=management mantained=maintained
manufacturedd=manufactured manufature=manufacture manufatured=manufactured manufaturing=manufacturing
mariage=marriage marjority=majority marketting=marketing marrage=marriage marraige=marriage marryied=married
mathamatics=mathematics mathematican=mathematician mathematicas=mathematics matheticians=mathematicians
mathmatically=mathematically mathmatician=mathematician mathmaticians=mathematicians mchanics=mechanics
meaing=meaning meaninng=meaning meating=meeting medacine=medicine medecine=medicine medeival=medieval
medevial=medieval medievel=medieval meeing=meeting meetign=meeting memeber=member menally=mentally mesage=message
messege=message methaphor=metaphor metting=meeting milennium=millennium milion=million miliraty=military
millenium=millennium millitary=military millon=million miltary=military minature=miniature minumum=minimum
miscelaneous=miscellaneous miscellanious=miscellaneous miscellanous=miscellaneous mischevious=mischievous
mischievious=mischievous misile=missile mispell=misspell mispelled=misspelled missle=missile misterious=mysterious
misteryous=mysterious mkae=make mkaes=makes mkaing=making mkea=make modle=model moent=moment moeny=money
moleclues=molecules monring=morning montains=mountains mornign=morning motiviated=motivated movei=movie
movment=movement mroe=more muder=murder mudering=murdering multipled=multiplied munbers=numbers muscial=musical
muscician=musician muscicians=musicians mysef=myself mysterous=mysterious naieve=naive naturaly=naturally
naturely=naturally naturual=natural naturually=naturally necassary=necessary neccesarily=necessarily
neccesary=necessary neccessarily=necessarily neccessary=necessary necesarily=necessarily necesary=necessary
neglible=negligible negligable=negligible negociate=negotiate negociation=negotiation negociations=negotiations
negotation=negotiation neice=niece nessasarily=necessarily nessecary=necessary nessesary=necessary
neverthless=nevertheless newletters=newsletters nkow=know nkwo=know nmae=name nonsence=nonsense
nontheless=nonetheless noone=no_one norhern=northern northen=northern notabley=notably noteable=notable
noteably=notably nothern=northern noticable=noticeable noticably=noticeably noticeing=noticing noticible=noticeable
notwhithstanding=notwithstanding nowdays=nowadays nucular=nuclear nuculear=nuclear nuisanse=nuisance
numberous=numerous nusance=nuisance obession=obsession obssessed=obsessed obstruced=obstructed ocasion=occasion
ocasional=occasional ocasionally=occasionally ocasionaly=occasionally ocasions=occasions ocassion=occasion
ocassional=occasional ocassionally=occasionally ocassionaly=occasionally ocassions=occasions occaison=occasion
occassion=occasion occassional=occasional occassionally=occasionally occassionaly=occasionally occassions=occasions
occationally=occasionally occour=occur occurance=occurrence occurances=occurrences occured=occurred
occurence=occurrence occurences=occurrences occuring=occurring occurr=occur occurrance=occurrence
occurrances=occurrences ocuntries=countries ocuntry=country ocurr=occur ocurrance=occurrence ocurred=occurred
ocurrence=occurrence ofcourse=of_course offcers=officers offcially=officially offereings=offerings offical=official
offically=officially officals=officials officaly=officially officialy=officially offred=offered oftenly=often
olther=other omision=omission omited=omitted omiting=omitting ommision=omission ommited=omitted ommiting=omitting
ommitted=omitted ommitting=omitting omre=more onyl=only oponent=opponent oportunity=opportunity opose=oppose
oposite=opposite oposition=opposition oppenly=openly oppertunity=opportunity oppinion=opinion opponant=opponent
oppononent=opponent oppositition=opposition oppossed=opposed opprotunity=opportunity oppurtunity=opportunity
opression=oppression orginal=original orginally=originally origanaly=originally originaly=originally
originially=originally originnally=originally origional=original orignally=originally orignially=originally
otehr=other oublisher=publisher oustanding=outstanding overthere=over_there overwelming=overwhelming
overwheliming=overwhelming owrk=work owudl=would oxigen=oxygen paide=paid paitience=patience pamplet=pamphlet
paralel=parallel paranthesis=parenthesis parellels=parallels parituclar=particular parliment=parliament
parrallel=parallel partialy=partially particually=particularly particualr=particular particuarly=particularly
particularily=particularly particulary=particularly pasengers=passengers pasttime=pastime paticular=particular
pblisher=publisher pbulisher=publisher peaple=people peculure=peculiar pedestrain=pedestrian peformed=performed
peice=piece penatly=penalty pensle=pencil peom=poem peoms=poems peopel=people peotry=poetry percepted=perceived
percieve=perceive percieved=perceived perfomance=performance performence=performance perhasp=perhaps
perheaps=perhaps perhpas=perhaps peristent=persistent permanant=permanent permenant=permanent
permenantly=permanently permissable=permissible peronal=personal perosnality=personality perphas=perhaps
perseverence=perseverance persistant=persistent personaly=personally personell=personnel personnell=personnel
persuded=persuaded persuit=pursuit peventing=preventing phenomenom=phenomenon phenomonenon=phenomenon
phenomonon=phenomenon phenonmena=phenomena philisopher=philosopher philisophical=philosophical philisophy=philosophy
philospher=philosopher philosphies=philosophies philosphy=philosophy phylosophical=philosophical
physicaly=physically piblisher=publisher plausable=plausible pleasent=pleasant plesant=pleasant plese=please
pocessing=processing poeoples=peoples poety=poetry poisin=poison polical=political politican=politician
politicans=politicians poltical=political polution=pollution pomotion=promotion poportional=proportional
popoulation=population popularaty=popularity populare=popular populer=popular porbably=probably porshan=portion
porshon=portion portayed=portrayed portraing=portraying posess=possess posessed=possessed posesses=possesses
posessing=possessing posession=possession posible=possible possable=possible possably=possibly posseses=possesses
possesing=possessing possesion=possession possessess=possesses possibile=possible possibilty=possibility
possiblility=possibility possiblilty=possibility possiblities=possibilities possiblity=possibility
possition=position postion=position postive=positive potatoe=potato potatos=potatoes potentialy=potentially
potrayed=portrayed poulations=populations poverful=powerful poweful=powerful powerfull=powerful ppublisher=publisher
practial=practical practially=practically practicaly=practically practicly=practically pratice=practice
precedessor=predecessor preceed=precede preceeded=preceded preceeding=preceding preceeds=precedes
precentage=percentage precice=precise precisly=precisely predecesors=predecessors predicatble=predictable
predicitons=predictions prefered=preferred prefering=preferring preferrably=preferably preformance=performance
preiod=period preliferation=proliferation premission=permission prepair=prepare prepartion=preparation
preperation=preparation preriod=period presense=presence prespective=perspective presumabely=presumably
presumibly=presumably pretection=protection prevelant=prevalent preverse=perverse previvous=previous
pricipal=principal priciple=principle primarly=primarily primative=primitive primatives=primitives
principly=principally prinicipal=principal privalege=privilege privaleges=privileges priveledges=privileges
privelege=privilege priveleged=privileged priveleges=privileges privelige=privilege priveliged=privileged
priveliges=privileges privelleges=privileges privilage=privilege priviledge=privilege priviledges=privileges
privilige=privilege privledge=privilege privte=private probabaly=probably probabilaty=probability probablly=probably
probalibity=probability probaly=probably probelm=problem probly=probably proccess=process proccessing=processing
procedger=procedure procedings=proceedings proceedure=procedure proces=process profesional=professional
profesor=professor professer=professor proffesion=profession proffesional=professional proffesor=professor
proffession=profession proffessional=professional proffessor=professor progessed=progressed prominant=prominent
promotted=promoted pronouced=pronounced pronounched=pronounced pronounciation=pronunciation proove=prove
prooved=proved propietary=proprietary propmted=prompted propoganda=propaganda propostion=proposition
propotions=proportions propper=proper propperly=properly proprietory=proprietary protocal=protocol
protrayed=portrayed provacative=provocative provded=provided provisiosn=provision provisonal=provisional
proximty=proximity psuedo=pseudo psycology=psychology pubilsher=publisher pubisher=publisher publiaher=publisher
publically=publicly publicaly=publicly publicher=publisher publihser=publisher publisehr=publisher
publiser=publisher publisger=publisher publisheed=published publisherr=publisher publishher=publisher
publishor=publisher publishre=publisher publissher=publisher publlisher=publisher publsiher=publisher
publusher=publisher puchasing=purchasing pulisher=publisher puplisher=publisher pursuade=persuade
pursuaded=persuaded pursuades=persuades pususading=persuading puting=putting pwoer=power quantaty=quantity
quantitiy=quantity quarentine=quarantine quesiton=question questionaire=questionnaire questoin=question
questonable=questionable quicklyu=quickly raelly=really reacing=reaching reacll=recall realitvely=relatively
realsitic=realistic realtions=relations realy=really realyl=really reasearch=research rebiulding=rebuilding
reccomend=recommend reccomendation=recommendation reccomendations=recommendations reccomended=recommended
reccomending=recommending reccommend=recommend reccommended=recommended reccommending=recommending
recepient=recipient recepients=recipients receving=receiving reched=reached recidents=residents
reciepents=recipients reciept=receipt recieve=receive recieved=received reciever=receiver recieves=receives
recieving=receiving recipiant=recipient recipiants=recipients recive=receive recived=received recomend=recommend
recomendation=recommendation recomended=recommended recomending=recommending recomends=recommends
recommedations=recommendations recquired=required recrational=recreational recrod=record recuiting=recruiting
rediculous=ridiculous refedendum=referendum referance=reference referece=reference refereces=references
refered=referred referemce=reference referemces=references referencs=references referenece=reference
refereneced=referenced refereneces=references referiang=referring refering=referring refernces=references
referrence=reference referrences=references referrs=refers reffered=referred refference=reference
reffering=referring refrence=reference refrences=references refrers=refers refusla=refusal regadrs=regards
regardes=regards regaurds=regards regluar=regular reguards=regards reguarly=regularly regulaion=regulation
regularily=regularly reivew=review relaly=really relatiopnship=relationship relativly=relatively releive=relieve
releived=relieved releses=releases relevence=relevance relevent=relevant reliablity=reliability religeous=religious
religous=religious relitavely=relatively relpacement=replacement remaing=remaining rember=remember remeber=remember
remenicent=reminiscent reminescent=reminiscent reminscent=reminiscent reminsicent=reminiscent renedered=rendered
repectively=respectively repeition=repetition repeteadly=repeatedly repetion=repetition repid=rapid
repitition=repetition reponse=response reponsible=responsible represantative=representative
representive=representative representives=representatives reprtoire=repertoire repsectively=respectively
reptition=repetition requirment=requirement requred=required resaurant=restaurant rescource=resource
resembelance=resemblance resembes=resembles resemblence=resemblance resistence=resistance resouce=resource
respectivly=respectively responce=response responibilities=responsibilities responisble=responsible
responnsibilty=responsibility responsability=responsibility responsibile=responsible
responsibilites=responsibilities responsiblities=responsibilities responsiblity=responsibility
ressemblance=resemblance ressemble=resemble ressembled=resembled ressemblence=resemblance ressembling=resembling
ressurection=resurrection ressurrection=resurrection restarant=restaurant restarants=restaurants
restaraunt=restaurant restaraunts=restaurants restauraunt=restaurant resteraunt=restaurant resteraunts=restaurants
resticted=restricted resturant=restaurant resturants=restaurants resturaunt=restaurant resturaunts=restaurants
retreive=retrieve returnd=returned reveiw=review revolutionar=revolutionary rewitten=rewritten rewriet=rewrite
rference=reference rferences=references rhymme=rhyme rhythem=rhythm rhythim=rhythm rigourous=rigorous
rininging=ringing rocord=record rougly=roughly rulle=rule runing=running runnung=running rwite=write rythem=rhythm
rythim=rhythm rythm=rhythm rythym=rhythm sacrafice=sacrifice saftey=safety safty=safety salery=salary
sandwhich=sandwich satelite=satellite satelites=satellites satisfactority=satisfactorily sattelite=satellite
sattelites=satellites saught=sought saveing=saving scedule=schedule schedual=schedule scientfic=scientific
scientifc=scientific scientis=scientist scince=science scinece=science scirpt=script seach=search seached=searched
seaches=searches secratary=secretary secretery=secretary seeked=sought seige=siege seing=seeing seinor=senior
senarios=scenarios senstive=sensitive sentance=sentence seperate=separate seperated=separated seperately=separately
seperates=separates seperating=separating seperation=separation severeal=several severley=severely severly=severely
sevice=service shaddow=shadow shedule=schedule shineing=shining shiped=shipped shiping=shipping shorly=shortly
shoudl=should sicne=since sieze=seize siginificant=significant signficant=significant signficiant=significant
signifantly=significantly significently=significantly signifigant=significant signifigantly=significantly
similarily=similarly similer=similar similiar=similar similiarity=similarity similiarly=similarly simmilar=similar
simpley=simply simplier=simpler simular=similar simultanous=simultaneous simultanously=simultaneously
sincerley=sincerely sincerly=sincerely slighly=slightly slowy=slowly smae=same smoe=some sneeks=sneaks
socalism=socialism socities=societies soem=some sofware=software sohw=show soilders=soldiers soley=solely
soliders=soldiers somene=someone somtimes=sometimes somwhere=somewhere sophicated=sophisticated
sorrounding=surrounding sotry=story soudn=sound soudns=sounds sountrack=soundtrack sourth=south sourthern=southern
speach=speech specfic=specific specifiying=specifying speciman=specimen spectauclar=spectacular spectum=spectrum
speices=species speling=spelling spoace=space sponser=sponsor sponsered=sponsored spontanous=spontaneous
sponzored=sponsored sppeches=speeches spreaded=spread sprech=speech spriritual=spiritual spritual=spiritual
sqaure=square stablility=stability staion=station standars=standards stange=strange startegic=strategic
startegies=strategies startegy=strategy stategy=strategy statememts=statements statment=statement
sterotypes=stereotypes stingent=stringent stirrs=stirs stlye=style stomache=stomach stopry=story storeis=stories
storise=stories stornegst=strongest stoyr=story stpo=stop stradegies=strategies stradegy=strategy stregth=strength
strenghen=strengthen strenght=strength strenghten=strengthen structual=structural stubborness=stubbornness
stucture=structure stuctured=structured studdy=study studing=studying stuggling=struggling sturcture=structure
subsidary=subsidiary subsiduary=subsidiary subsquent=subsequent subsquently=subsequently substace=substance
substancial=substantial substatial=substantial substituded=substituted subtances=substances succceeded=succeeded
succedded=succeeded succeded=succeeded succeds=succeeds succesful=successful succesfully=successfully
succesfuly=successfully succesion=succession succesive=successive successfull=successful successully=successfully
succsess=success succsessfull=successful suceed=succeed suceeded=succeeded suceeding=succeeding suceeds=succeeds
sucesful=successful sucesfully=successfully sucesfuly=successfully sucesion=succession sucess=success
sucessful=successful sucessfull=successful sucessfully=successfully sucessfuly=successfully sucession=succession
sucessive=successive sucessor=successor sucessot=successor sucidial=suicidal sudent=student sudents=students
sufferred=suffered sufferring=suffering sufficent=sufficient sufficently=sufficiently sumary=summary suop=soup
suphisticated=sophisticated supose=suppose suposed=supposed suposedly=supposedly suposes=supposes suposing=supposing
suppoed=supposed supposably=supposedly supposingly=supposedly suppy=supply supress=suppress supressed=suppressed
supresses=suppresses supressing=suppressing suprise=surprise suprised=surprised suprising=surprising
suprisingly=surprisingly suprize=surprise suprized=surprised suprizing=surprising suprizingly=surprisingly
surfce=surface surley=surely suround=surround surounded=surrounded surounding=surrounding suroundings=surroundings
surounds=surrounds surpress=suppress surpressed=suppressed surprize=surprise surprizingly=surprisingly
surronded=surrounded surrouded=surrounded surrouding=surrounding survivied=survived suseptable=susceptible
suseptible=susceptible suspention=suspension swaer=swear swaers=swears swepth=swept swiming=swimming syas=says
symetry=symmetry symettric=symmetric synonomous=synonymous synonymns=synonyms synphony=symphony sypmtoms=symptoms
sytem=system sytle=style tabacco=tobacco tahn=than tahnks=thanks taht=that talekd=talked tatoo=tattoo teached=taught
techiniques=techniques technnology=technology technolgy=technology teh=the tehy=they telelevision=television
televsion=television temerature=temperature temperarily=temporarily temperment=temperament tempertaure=temperature
temperture=temperature temprary=temporary tendacy=tendency tendancies=tendencies tendancy=tendency
tepmorarily=temporarily terriory=territory territorist=terrorist territoy=territory terroist=terrorist tghe=the
thakns=thanks thankyou=thank_you thansk=thanks theese=these theif=thief theives=thieves themselfs=themselves
themslves=themselves therafter=thereafter therby=thereby theri=their thgat=that thge=the thier=their thign=thing
thigns=things thigsn=things thikn=think thikns=thinks thiunk=think thna=than thnak=thank thnaks=thanks thne=then
thnig=thing thnigs=things thoughout=throughout threatend=threatened threatning=threatening threee=three
threshhold=threshold throrough=thorough througout=throughout thsi=this thsoe=those thta=that thyat=that tihkn=think
tihs=this timne=time tjhe=the tkae=take tkaes=takes tkaing=taking tlaking=talking tobbaco=tobacco todya=today
togather=together togehter=together toghether=together tolerence=tolerance tomatos=tomatoes tommorow=tomorrow
tommorrow=tomorrow tomorow=tomorrow tomrrow=tomorrow tongiht=tonight totaly=totally tothe=to_the toubles=troubles
tounge=tongue towords=towards towrad=toward tradgedy=tragedy tradionally=traditionally traditionaly=traditionally
traditionnal=traditional traditition=tradition tradtionally=traditionally trafic=traffic tranform=transform
tranformed=transformed transfered=transferred transfering=transferring transformaton=transformation
transistion=transition translater=translator trigered=triggered triguered=triggered triology=trilogy truely=truly
truley=truly twelth=twelfth twpo=two tyhat=that tyhe=they typcial=typical typicaly=typically tyrany=tyranny
ublisher=publisher udpate=update udpated=updated ultimely=ultimately unahppy=unhappy unavailible=unavailable
unbeleivable=unbelievable uncertainity=uncertainty unconcious=unconscious underate=underrate underated=underrated
understoon=understood undesireable=undesirable undoubtely=undoubtedly undreground=underground uneccesary=unnecessary
unecessary=unnecessary unforetunately=unfortunately unfortunatley=unfortunately unfortunatly=unfortunately
unfourtunately=unfortunately unitl=until univeral=universal univeristies=universities univeristy=university
univerity=university universtiy=university univesities=universities univesity=university unkown=unknown
unlikey=unlikely unneccesarily=unnecessarily unneccesary=unnecessary unneccessarily=unnecessarily
unneccessary=unnecessary unnecesarily=unnecessarily unnecesary=unnecessary unoffical=unofficial unplesant=unpleasant
unsuccesful=unsuccessful unsuccessfull=unsuccessful unsucesful=unsuccessful unsucessful=unsuccessful
unsucessfull=unsuccessful untill=until unuseable=unusable unusuable=unusable unviersity=university upate=update
upcomming=upcoming upgradded=upgraded upto=up_to usally=usually useage=usage usefull=useful usefuly=usefully
useing=using usualy=usually ususally=usually vaccum=vacuum vaccume=vacuum vaccuum=vacuum vacinity=vicinity
vaieties=varieties vailidty=validity valuble=valuable valueable=valuable varations=variations varient=variant
variey=variety varing=varying varities=varieties varity=variety vegatable=vegetable vegatarian=vegetarian
vegeterian=vegetarian vegitable=vegetable vegitables=vegetables vegtable=vegetable vehical=vehicle vehicule=vehicle
verfication=verification verison=version verisons=versions vetween=between veyr=very vincinity=vicinity
violentce=violence virtualy=virtually virutal=virtual virutally=virtually visable=visible visting=visiting
vistors=visitors volontary=voluntary volonteer=volunteer volonteered=volunteered volonteering=volunteering
volonteers=volunteers volounteer=volunteer volounteered=volunteered volounteering=volunteering
volounteers=volunteers volumne=volume vreity=variety vrey=very vriety=variety vyer=very vyre=very waht=what
warantee=warranty warrent=warrant wass=was watn=want wehn=when wekend=weekend wellcome=welcome wensday=Wednesday
whant=want whants=wants whcih=which wheras=whereas wherease=whereas whereever=wherever whic=which whihc=which
whith=with whlch=which wholey=wholly whta=what whther=whether wich=which widesread=widespread wief=wife wierd=weird
wiew=view wiht=with willk=will wirting=writing withdrawl=withdrawal withh=with withold=withhold witht=with witn=with
wiull=will wnat=want wnated=wanted wnats=wants wohle=whole wokr=work wokring=working wonderfull=wonderful
wordlwide=worldwide workststion=workstation woudl=would wriet=write writen=written writting=writing wroet=wrote
wrok=work wroking=working wtih=with wupport=support yaer=year yaerly=yearly yaers=years yatch=yacht yearm=year
yeasr=years yeild=yield yera=year yeras=years yersa=years yesturday=yesterday youself=yourself yrea=year ytou=you
yuo=you
`;

let map: Map<string, string> | null = null;

/** Lower-cased misspelling -> correction. */
export function misspellings(): ReadonlyMap<string, string> {
  if (map !== null) return map;
  const m = new Map<string, string>();
  for (const entry of MISSPELLINGS_DATA.split(/\s+/)) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    m.set(entry.slice(0, eq), entry.slice(eq + 1).replace(/_/g, ' '));
  }
  map = m;
  return m;
}
